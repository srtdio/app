// Agora Chat REST client for group lifecycle, scoped to exactly what the
// chat-agora-sync Worker (A2b) needs: create a group, add/remove a member, and
// rename a group. Every call is authenticated with an app token minted from the
// App ID + App Certificate via ChatTokenBuilder.buildAppToken - the same scheme
// the chat-token Worker uses, never a hand-rolled signature - and goes through
// tracedFetch so it carries X-Trace-Id.
//
// Idempotency lives here: Agora's "already a member" and "user/group not found"
// responses are treated as success, so a Realtime redelivery (add an existing
// member, remove an absent one) is a safe no-op rather than a crash. Genuine
// faults still throw and are swallowed per-event by the consumer, with the
// reconciliation cron as the backstop.

import { ChatTokenBuilder } from 'agora-token';
import { tracedFetch } from '@/server/traced-fetch';

/** App-token TTL for REST auth: one hour is ample for a single call. */
const APP_TOKEN_TTL_SECONDS = 3_600;

/** Default ceiling for a freshly created Agora group. */
const DEFAULT_MAX_USERS = 2_000;

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

/**
 * True when a non-2xx body reports a benign idempotent condition: the user is
 * already a member, or the user / group does not exist. These mean the desired
 * state already holds, so the caller treats them as success.
 */
function isIdempotentMiss(status: number, body: string): boolean {
  const lowered = body.toLowerCase();
  return (
    lowered.includes('already') ||
    lowered.includes('user_not_found') ||
    lowered.includes('not found') ||
    lowered.includes('does not exist') ||
    status === 404
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

  return {
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
        throw new Error(`Agora group create failed: ${response.status} ${await response.text()}`);
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
      if (isIdempotentMiss(response.status, text)) {
        return;
      }
      throw new Error(`Agora add-member failed: ${response.status} ${text}`);
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
      if (isIdempotentMiss(response.status, text)) {
        return;
      }
      throw new Error(`Agora remove-member failed: ${response.status} ${text}`);
    },

    async updateGroupName(groupId, name, traceId) {
      const response = await fetchImpl(
        `${base}/chatgroups/${groupId}`,
        { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ groupname: name }) },
        traceId,
      );
      if (!response.ok) {
        throw new Error(`Agora group rename failed: ${response.status} ${await response.text()}`);
      }
    },
  };
}
