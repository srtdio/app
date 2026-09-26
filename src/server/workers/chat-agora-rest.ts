// Agora Chat REST client for group lifecycle, scoped to exactly what the
// chat-agora-sync Worker (A2b) needs: register users, create a group, add/remove
// a member, and rename a group. Every call is authenticated with an app token minted from the
// App ID + App Certificate via ChatTokenBuilder.buildAppToken - the same scheme
// the chat-token Worker uses, never a hand-rolled signature - and goes through
// tracedFetch so it carries X-Trace-Id.
//
// Idempotency lives here, matched per operation: "already a member" on add,
// "not a member" / "not found" on remove, and "already exists" on register are
// treated as success, so a retry is a safe no-op rather than a crash. Genuine
// faults throw an AgoraRestError carrying status, body and operation as
// separate fields so the consumer can log them without parsing a message.

import { ChatTokenBuilder } from 'agora-token';
import { tracedFetch } from '@/server/traced-fetch';

/** App-token TTL for REST auth: one hour is ample for a single call. */
const APP_TOKEN_TTL_SECONDS = 3_600;

/** Default ceiling for a freshly created Agora group. */
const DEFAULT_MAX_USERS = 2_000;

/** Agora's per-request ceiling for bulk user registration. */
export const REGISTER_BATCH_SIZE = 60;

/** Agora error bodies are truncated to this many chars before they are logged. */
export const MAX_AGORA_BODY_CHARS = 500;

/** The REST operations the client performs; logged as the `operation` field. */
export type AgoraOperation =
  | 'register_users'
  | 'create_group'
  | 'add_member'
  | 'remove_member'
  | 'rename_group';

/** A non-2xx Agora REST response, with the log fields kept apart. */
export class AgoraRestError extends Error {
  readonly operation: AgoraOperation;
  readonly status: number;
  /** Response body, truncated to MAX_AGORA_BODY_CHARS. */
  readonly body: string;

  constructor(operation: AgoraOperation, status: number, body: string) {
    const truncated = body.slice(0, MAX_AGORA_BODY_CHARS);
    super(`Agora ${operation} failed: ${status} ${truncated}`);
    this.name = 'AgoraRestError';
    this.operation = operation;
    this.status = status;
    this.body = truncated;
  }
}

export interface AgoraRestConfig {
  appId: string;
  appCertificate: string;
  /** Base host + org + app for the Agora Chat REST API, no trailing slash. */
  restUrl: string;
}

/** tracedFetch's shape, narrowed to header-injecting calls the client makes. */
export type TracedFetchFn = (
  input: string,
  init: RequestInit,
  traceId: string,
) => Promise<Response>;

/** The group operations the Worker performs against Agora; injected for tests. */
export interface AgoraGroupApi {
  /**
   * Register Agora users so group operations never reference a missing one.
   * Bulk (REGISTER_BATCH_SIZE per request); an already-registered user counts
   * as success.
   */
  ensureUsers(usernames: string[], traceId: string): Promise<void>;
  /** Create a group and return Agora's generated group id. */
  createGroup(
    args: { name: string; ownerUsername: string; memberUsernames: string[] },
    traceId: string,
  ): Promise<string>;
  /** Add a user to a group. A no-op if they are already a member. */
  addMember(groupId: string, username: string, traceId: string): Promise<void>;
  /** Remove a user from a group. A no-op if they are not a member. */
  removeMember(groupId: string, username: string, traceId: string): Promise<void>;
  /** Rename a group. */
  updateGroupName(groupId: string, name: string, traceId: string): Promise<void>;
}

/** Render any thrown value into a stable log string (logging only). */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return JSON.stringify({ code: e.code, message: e.message, details: e.details });
  }
  return String(error);
}

const ADD_MEMBER_SUCCESS_PHRASES = ['already', 'already in', 'exist'] as const;

const REMOVE_MEMBER_SUCCESS_PHRASES = [
  'not a member',
  'not in group',
  'not in the group',
  'user_not_found',
  'not found',
  'does not exist',
  'not exist',
] as const;

function matchesAny(status: number, body: string, phrases: readonly string[]): boolean {
  if (status === 404) return true;
  const lowered = body.toLowerCase();
  return phrases.some((phrase) => lowered.includes(phrase));
}

/** True when a failed add-member response means the user is already in the group. */
export function isAddMemberIdempotent(status: number, body: string): boolean {
  return matchesAny(status, body, ADD_MEMBER_SUCCESS_PHRASES);
}

/** True when a failed remove-member response means the user is already out. */
export function isRemoveMemberIdempotent(status: number, body: string): boolean {
  return matchesAny(status, body, REMOVE_MEMBER_SUCCESS_PHRASES);
}

/**
 * True when a failed register response means the username already exists
 * (Agora: 400 duplicate_unique_property_exists), the chat-token Worker's
 * idempotent success path.
 */
export function isRegisterDuplicate(status: number, body: string): boolean {
  const lowered = body.toLowerCase();
  return (
    status === 400 &&
    (lowered.includes('already exists') || lowered.includes('duplicate_unique_property_exists'))
  );
}

/** Build the Agora REST group client backed by the live REST API. */
export function createAgoraGroupApi(
  config: AgoraRestConfig,
  fetchImpl: TracedFetchFn = tracedFetch,
): AgoraGroupApi {
  const base = config.restUrl.replace(/\/+$/, '');

  function authHeaders(): Record<string, string> {
    const appToken = ChatTokenBuilder.buildAppToken(
      config.appId,
      config.appCertificate,
      APP_TOKEN_TTL_SECONDS,
    );
    return { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' };
  }

  /** POST /users with the chat-token Worker's body shape (one object or an array). */
  function registerBody(usernames: string[]): string {
    const users = usernames.map((username) => ({ username, password: crypto.randomUUID() }));
    return JSON.stringify(users.length === 1 ? users[0] : users);
  }

  async function register(usernames: string[], traceId: string): Promise<Response> {
    return fetchImpl(
      `${base}/users`,
      { method: 'POST', headers: authHeaders(), body: registerBody(usernames) },
      traceId,
    );
  }

  return {
    async ensureUsers(usernames, traceId) {
      const unique = [...new Set(usernames)];
      for (let i = 0; i < unique.length; i += REGISTER_BATCH_SIZE) {
        const chunk = unique.slice(i, i + REGISTER_BATCH_SIZE);
        const response = await register(chunk, traceId);
        if (response.ok) continue;
        const text = await response.text();
        if (!isRegisterDuplicate(response.status, text)) {
          throw new AgoraRestError('register_users', response.status, text);
        }
        if (chunk.length === 1) continue;
        // Agora rejects the whole bulk request when any username exists, so fall
        // back to one call per user for this chunk; duplicates are success.
        for (const username of chunk) {
          const single = await register([username], traceId);
          if (single.ok) continue;
          const singleText = await single.text();
          if (!isRegisterDuplicate(single.status, singleText)) {
            throw new AgoraRestError('register_users', single.status, singleText);
          }
        }
      }
    },

    async createGroup(args, traceId) {
      const response = await fetchImpl(
        `${base}/chatgroups`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            groupname: args.name,
            desc: args.name,
            public: true,
            maxusers: DEFAULT_MAX_USERS,
            owner: args.ownerUsername,
            // Agora auto-adds the owner; send the rest as the initial roster.
            members: args.memberUsernames.filter((u) => u !== args.ownerUsername),
          }),
        },
        traceId,
      );
      if (!response.ok) {
        throw new AgoraRestError('create_group', response.status, await response.text());
      }
      const parsed = (await response.json()) as { data?: { groupid?: unknown } };
      const groupId = parsed.data?.groupid;
      if (typeof groupId !== 'string' || groupId === '') {
        throw new Error('Agora group create returned no groupid');
      }
      return groupId;
    },

    async addMember(groupId, username, traceId) {
      const response = await fetchImpl(
        `${base}/chatgroups/${groupId}/users/${username}`,
        { method: 'POST', headers: authHeaders() },
        traceId,
      );
      if (response.ok) {
        return;
      }
      const text = await response.text();
      if (isAddMemberIdempotent(response.status, text)) {
        return;
      }
      throw new AgoraRestError('add_member', response.status, text);
    },

    async removeMember(groupId, username, traceId) {
      const response = await fetchImpl(
        `${base}/chatgroups/${groupId}/users/${username}`,
        { method: 'DELETE', headers: authHeaders() },
        traceId,
      );
      if (response.ok) {
        return;
      }
      const text = await response.text();
      if (isRemoveMemberIdempotent(response.status, text)) {
        return;
      }
      throw new AgoraRestError('remove_member', response.status, text);
    },

    async updateGroupName(groupId, name, traceId) {
      const response = await fetchImpl(
        `${base}/chatgroups/${groupId}`,
        { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ groupname: name }) },
        traceId,
      );
      if (!response.ok) {
        throw new AgoraRestError('rename_group', response.status, await response.text());
      }
    },
  };
}
