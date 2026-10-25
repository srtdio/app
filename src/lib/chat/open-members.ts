// The people reads a chat open makes, answered from what the app already
// holds before anything goes to the network.
//
// Names and picker rows: the shared workspace members cache
// (src/lib/workspace-members.ts, one listMembers + one readProfiles per user
// and workspace, shared with the post, brief, Settings and chat sheets) holds
// every membership row and every member's profile. While it holds a good read
// from the last MEMBERS_STALE_MS, the open's sender and @mention names
// (readMentionProfiles) and the mention picker rows (readChatMembers) come from
// it: no users or workspace_members request. Only ids it cannot answer (no
// profile held) are read, with the same batched read as before. A cold cache
// reads exactly as before and warms the cache in the background, so the next
// open in this workspace reads nothing. Membership means the same here as in
// those reads: an active, non-removed workspace_members row.
//
// Group member ids: the open asks group_members twice in one commit (the live
// target and typing names, and the mention picker). Concurrent asks for the
// same group share one in-flight read; a settled read is never reused (a
// roster re-read after a member change always reads again).
//
// RLS stays the only boundary: the cache was read under the same user and
// workspace (its key), and nothing here widens a read.

import type { Client, Result } from '@srtdio/rpc';
import {
  currentMembers,
  ensureWorkspaceMembers,
  peekWorkspaceMembers,
  type WorkspaceMembersData,
} from '@/lib/workspace-members';
import {
  listGroupMemberIds,
  readChatMembers,
  readMentionProfiles,
  withReadTimeout,
  type ChatMember,
  type MentionProfile,
} from '@/lib/chat-reads';
import { SIGNOUT_EVENT } from '@/lib/events';

/** The user ids of the current members (active, not removed). Pure. */
function currentIds(data: Pick<WorkspaceMembersData, 'rows'>): Set<string> {
  return new Set(currentMembers(data.rows).map((row) => row.user_id));
}

/**
 * Mention profiles for `userIds` from the held members: each id whose profile
 * is held, marked with current membership, and the ids the cache cannot answer
 * (no profile held: never a member here, or a profile RLS hid). Pure.
 */
export function mentionProfilesFromMembers(
  data: Pick<WorkspaceMembersData, 'rows' | 'profiles'>,
  userIds: readonly string[],
): { profiles: MentionProfile[]; missing: string[] } {
  const current = currentIds(data);
  const profiles: MentionProfile[] = [];
  const missing: string[] = [];
  for (const id of new Set(userIds)) {
    const profile = data.profiles.get(id);
    if (profile === undefined) {
      missing.push(id);
      continue;
    }
    profiles.push({
      userId: profile.userId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      username: profile.username ?? null,
      member: current.has(id),
    });
  }
  return { profiles, missing };
}

/**
 * Picker rows for `userIds` from the held members: each current member whose
 * profile is held, with their role; an id with no current membership is left
 * out (readChatMembers leaves it out too); a current member whose profile is
 * not held is `missing` (read it). Pure.
 */
export function chatMembersFromMembers(
  data: Pick<WorkspaceMembersData, 'rows' | 'profiles'>,
  userIds: readonly string[],
): { members: ChatMember[]; missing: string[] } {
  const roleOf = new Map<string, string>();
  for (const row of currentMembers(data.rows)) roleOf.set(row.user_id, row.role);
  const members: ChatMember[] = [];
  const missing: string[] = [];
  for (const id of new Set(userIds)) {
    const role = roleOf.get(id);
    if (role === undefined) continue;
    const profile = data.profiles.get(id);
    if (profile === undefined) {
      missing.push(id);
      continue;
    }
    members.push({
      userId: profile.userId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      username: profile.username ?? null,
      role,
    });
  }
  return { members, missing };
}

/** The held members for this user and workspace, or null (cold: warmed for next time). */
function heldMembers(userId: string, workspaceId: string): WorkspaceMembersData | null {
  const held = peekWorkspaceMembers(userId, workspaceId);
  if (held === null && userId !== '' && workspaceId !== '') {
    ensureWorkspaceMembers(userId, workspaceId);
  }
  return held;
}

/**
 * readMentionProfiles, answered from the shared members cache when it is warm:
 * only the ids it cannot answer are read (none: no request). Cold: the read
 * exactly as before. A failed read of the rest fails the whole call, as one
 * read did before (no id is marked former on a read that did not answer).
 */
export async function readMentionProfilesShared(
  client: Client,
  params: { userId: string; workspaceId: string; userIds: string[]; timeoutMs?: number },
): Promise<Result<MentionProfile[]>> {
  const read = (userIds: string[]): Promise<Result<MentionProfile[]>> =>
    readMentionProfiles(client, {
      workspaceId: params.workspaceId,
      userIds,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
  const held = heldMembers(params.userId, params.workspaceId);
  if (held === null) return read(params.userIds);
  const { profiles, missing } = mentionProfilesFromMembers(held, params.userIds);
  if (missing.length === 0) return { ok: true, data: profiles };
  const rest = await read(missing);
  if (!rest.ok) return rest;
  return { ok: true, data: [...profiles, ...rest.data] };
}

/**
 * readChatMembers, answered from the shared members cache when it is warm:
 * only current members whose profile is not held are read (none: no request).
 * Cold: the read exactly as before.
 */
export async function readChatMembersShared(
  client: Client,
  params: { userId: string; workspaceId: string; userIds: string[]; signal?: AbortSignal },
): Promise<Result<ChatMember[]>> {
  const read = (userIds: string[]): Promise<Result<ChatMember[]>> =>
    readChatMembers(client, {
      workspaceId: params.workspaceId,
      userIds,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
  const held = heldMembers(params.userId, params.workspaceId);
  if (held === null) return read(params.userIds);
  const { members, missing } = chatMembersFromMembers(held, params.userIds);
  if (missing.length === 0) return { ok: true, data: members };
  const rest = await read(missing);
  if (!rest.ok) return rest;
  return { ok: true, data: [...members, ...rest.data] };
}

/**
 * Post card approver names and roles from the held members (the card cache's
 * readNames: readProfiles + readApproverRoles over the approver ids), or null
 * when the cache is cold or does not hold every approver's profile (read as
 * before then). Roles come from every membership row, as readApproverRoles
 * reads them (no active filter). Pure over the cache; never reads.
 */
export function approverNamesFromMembers(
  userId: string,
  workspaceId: string,
  approverIds: readonly string[],
): { profiles: MentionProfile[]; roles: Map<string, string> } | null {
  const held = peekWorkspaceMembers(userId, workspaceId);
  if (held === null) return null;
  const { profiles, missing } = mentionProfilesFromMembers(held, approverIds);
  if (missing.length > 0) return null;
  const wanted = new Set(approverIds);
  const roles = new Map<string, string>();
  for (const row of held.rows) {
    if (wanted.has(row.user_id)) roles.set(row.user_id, row.role);
  }
  return { profiles, roles };
}

// ---------------------------------------------------------------------------
// Group member ids: one in-flight read per group
// ---------------------------------------------------------------------------

interface GroupRead {
  client: Client;
  promise: Promise<Result<string[]>>;
}

const groupReads = new Map<string, GroupRead>();

/** Forget every in-flight group read (sign-out; tests). */
export function resetGroupMemberReads(): void {
  groupReads.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, resetGroupMemberReads);
}

/** Wait for `promise`, or a failure the moment `signal` aborts. */
function awaitWith<T>(promise: Promise<Result<T>>, signal?: AbortSignal): Promise<Result<T>> {
  if (signal === undefined) return promise;
  const aborted: Result<T> = {
    ok: false,
    error: { code: 'unknown', message: 'listGroupMemberIds: aborted' },
  };
  if (signal.aborted) return Promise.resolve(aborted);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(aborted);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    });
  });
}

/**
 * listGroupMemberIds, shared while in flight: a second ask for the same group
 * (same client) joins the running read instead of reading again. The read is
 * bounded at 5s on its own; a caller's `signal` ends only that caller's wait.
 * Once settled it is forgotten, so the next ask always reads.
 */
export function readGroupMemberIdsShared(
  client: Client,
  params: { groupId: string; signal?: AbortSignal },
): Promise<Result<string[]>> {
  const running = groupReads.get(params.groupId);
  if (running !== undefined && running.client === client) {
    return awaitWith(running.promise, params.signal);
  }
  const entry: GroupRead = {
    client,
    promise: withReadTimeout((signal) =>
      listGroupMemberIds(client, { groupId: params.groupId, signal }),
    ),
  };
  groupReads.set(params.groupId, entry);
  void entry.promise.then(() => {
    if (groupReads.get(params.groupId) === entry) groupReads.delete(params.groupId);
  });
  return awaitWith(entry.promise, params.signal);
}
