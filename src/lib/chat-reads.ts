// Chat read layer for the Sorted registry side of chat.
//
// IMPORTANT: nothing here is on the live message-thread read path. The live
// thread is read from the Agora SDK only (see src/lib/chat/thread.ts). This
// module reads the Sorted-owned registry tables (chat_channels, groups, users)
// to build the channel list and to resolve sender display info, all through
// RLS-scoped SELECTs (no procs, no service role) mirroring @srtdio/workspace's
// listMembers. A Postgres message mirror exists for compliance/history; it is
// deliberately NOT read here so it can never leak onto the live path.
//
// Display resolution is BATCHED: one IN-clause read for every group name and
// one IN-clause read for every DM peer profile, never one read per channel.

import { mark } from '@/lib/perf-marks';
import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

type ChatChannelRow = Database['public']['Tables']['chat_channels']['Row'];
type GroupRow = Database['public']['Tables']['groups']['Row'];
type GroupMemberRow = Database['public']['Tables']['group_members']['Row'];
type UserRow = Database['public']['Tables']['users']['Row'];
type ChannelClearRow = Database['public']['Tables']['chat_channel_clears']['Row'];
type WorkspaceMemberRow = Database['public']['Tables']['workspace_members']['Row'];

/** A user's display info, the slice the chat UI shows. */
export interface ChatProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** The @username mentions show; absent or null for a profile read without it. */
  username?: string | null;
  /**
   * users.email_opt_in (catch-up emails). Absent for a profile read without it
   * (an older device-cache entry); the Members tag shows only when present.
   */
  emailOptIn?: boolean;
}

/** One conversation in the channel list, with display info already resolved. */
export interface ChannelSummary {
  channelId: string;
  /** 'notes' is the caller's own Personal notes chat (lib/chat/notes.ts builds it). */
  channelType: 'dm' | 'group' | 'notes';
  /** Title shown in the list: group name or the DM peer's display name. */
  title: string;
  /** Avatar src: the DM peer's users.avatar_url, or the group's groups.avatar_url. */
  avatarUrl: string | null;
  /** The group's creator (groups.created_by); null for DMs or when unknown. */
  createdBy?: string | null;
  /** The Agora group id for group channels; null until the sync worker stamps it. */
  agoraGroupId: string | null;
  /** The Sorted group id (chat_channels.entity_id) for group channels; null for DMs. */
  groupId: string | null;
  /** The DM peer's Sorted user id (the participant who is not the current user). */
  peerUserId: string | null;
  /**
   * The DM peer's workspace_members.role (raw value, labelled at render); null for
   * groups or when the peer has no active membership row. Optional so summaries
   * built elsewhere (tests, pickers) need not carry it.
   */
  role?: string | null;
  createdAt: string;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** A chat read (list, history, names, cards) that has not answered by now counts as failed. */
export const READ_TIMEOUT_MS = 5_000;

/**
 * Run one read with an abort timeout: the signal goes down the fetch path
 * (.abortSignal), and the read resolves to a failure once it fires even when
 * the transport ignores it. A thrown rejection is a failure too. Never throws.
 */
export async function withReadTimeout<T>(
  run: (signal: AbortSignal) => Promise<Result<T>>,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Result<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fail('read timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => run(controller.signal))
        .catch((error: unknown) => fail<T>(String(error))),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Hand a read's abort signal to its query builder, so a timed-out or cancelled
 * request is cancelled on the wire, not just ignored. The Supabase builders
 * always take one; a builder without .abortSignal (a test fake) runs as is.
 */
export function abortable<Q>(query: Q, signal: AbortSignal | undefined): Q {
  if (signal === undefined) return query;
  const attach = (query as { abortSignal?: (signal: AbortSignal) => Q }).abortSignal;
  return typeof attach === 'function' ? attach.call(query, signal) : query;
}

/** How long a read that missed its 5s deadline may still land before it is aborted. */
export const LATE_READ_GRACE_MS = 30_000;

/**
 * A read whose answer after the deadline still counts: it resolves to a failure
 * at `timeoutMs` (the caller shows its error state), but the request keeps
 * running until `graceMs` and a late success is handed to `onLate` (the data
 * then wins and the error clears). It is aborted at `graceMs`, or at once when
 * `cancel` fires (unmount, channel or workspace switch, Retry), after which
 * nothing is delivered. A thrown rejection is a failure. Never throws.
 * `onGiveUp` (optional) fires once when the read ends with no data and was not
 * cancelled: a failure (on time or late), or the grace end. It adds no timer.
 */
export function withLateRead<T>(
  run: (signal: AbortSignal) => Promise<Result<T>>,
  opts: {
    onLate: (data: T) => void;
    onGiveUp?: () => void;
    cancel?: AbortSignal;
    timeoutMs?: number;
    graceMs?: number;
  },
): Promise<Result<T>> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? LATE_READ_GRACE_MS;
  let late = false;
  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let resolveFirst: (result: Result<T>) => void = () => {};
  const stop = (): void => {
    if (deadline !== undefined) clearTimeout(deadline);
    if (grace !== undefined) clearTimeout(grace);
    opts.cancel?.removeEventListener('abort', onCancel);
  };
  function onCancel(): void {
    settled = true;
    stop();
    controller.abort();
    // A cancel before the deadline still settles the caller's await.
    if (!late) resolveFirst(fail('read cancelled'));
  }
  if (opts.cancel?.aborted === true) return Promise.resolve(fail('read cancelled'));
  opts.cancel?.addEventListener('abort', onCancel);
  return new Promise<Result<T>>((resolve) => {
    resolveFirst = resolve;
    deadline = setTimeout(() => {
      late = true;
      resolve(fail('read timed out'));
      grace = setTimeout(
        () => {
          settled = true;
          stop();
          controller.abort();
          opts.onGiveUp?.();
        },
        Math.max(0, graceMs - timeoutMs),
      );
    }, timeoutMs);
    void Promise.resolve()
      .then(() => run(controller.signal))
      .catch((error: unknown) => fail<T>(String(error)))
      .then((result) => {
        if (settled) return;
        settled = true;
        stop();
        if (!late) {
          resolve(result);
          if (!result.ok) opts.onGiveUp?.();
          return;
        }
        if (result.ok) opts.onLate(result.data);
        else opts.onGiveUp?.();
      });
  });
}

/** The DM peer is whichever participant is not the current user. */
export function dmPeerId(
  channel: Pick<ChatChannelRow, 'dm_user_a' | 'dm_user_b'>,
  currentUserId: string,
): string | null {
  if (channel.dm_user_a !== null && channel.dm_user_a !== currentUserId) return channel.dm_user_a;
  if (channel.dm_user_b !== null && channel.dm_user_b !== currentUserId) return channel.dm_user_b;
  return null;
}

/**
 * Shape raw registry rows into channel summaries. Pure, so display resolution is
 * unit-tested without a client: group channels take their name from groupsById
 * (keyed by entity_id) along with its photo, DM channels take the peer's
 * name/avatar from usersById.
 * Unknown ids fall back to a neutral label so a missing row never blanks the row.
 * rolesByUserId carries each DM peer's workspace role; a missing entry is null.
 */
export function shapeChannelSummaries(
  channels: ChatChannelRow[],
  groupsById: Map<string, GroupRow>,
  usersById: Map<string, UserRow>,
  currentUserId: string,
  rolesByUserId: Map<string, string> = new Map(),
): ChannelSummary[] {
  return channels.flatMap((channel): ChannelSummary[] => {
    // The notes chat is never a list row: the chat home pins its own tile,
    // built from the session (notesSummary), so it never waits on this read.
    if (channel.channel_type === 'notes') return [];
    if (channel.channel_type === 'group') {
      const group = channel.entity_id !== null ? groupsById.get(channel.entity_id) : undefined;
      return [
        {
          channelId: channel.channel_id,
          channelType: 'group',
          title: group?.name ?? 'Group',
          avatarUrl: group?.avatar_url ?? null,
          createdBy: group?.created_by ?? null,
          agoraGroupId: channel.agora_group_id,
          groupId: channel.entity_id,
          peerUserId: null,
          role: null,
          createdAt: channel.created_at,
        },
      ];
    }
    const peerId = dmPeerId(channel, currentUserId);
    const peer = peerId !== null ? usersById.get(peerId) : undefined;
    return [
      {
        channelId: channel.channel_id,
        channelType: 'dm',
        title: peer?.display_name ?? 'Direct message',
        avatarUrl: peer?.avatar_url ?? null,
        agoraGroupId: channel.agora_group_id,
        groupId: null,
        peerUserId: peerId,
        role: peerId !== null ? (rolesByUserId.get(peerId) ?? null) : null,
        createdAt: channel.created_at,
      },
    ];
  });
}

function indexBy<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return map;
}

/**
 * List a workspace's chat channels, newest first, each enriched with display
 * info. Four round-trips total regardless of channel count: the channel
 * registry, then one batched groups read (names AND photos; chat_channels has no
 * FK to groups, so PostgREST cannot embed it into the first read), one batched
 * users read and one batched workspace_members read for the DM peers' roles. Last-message
 * preview and unread counts are a later enhancement and are not built here.
 * Two stages, each round-trip with its own 5s (aborted when it fires): the
 * registry, then the groups, users and roles reads in parallel. `signal`
 * cancels every stage (a hang is a failed Result, never a wait).
 */
export async function listChannelSummaries(
  client: Client,
  params: { workspaceId: string; currentUserId: string },
  signal?: AbortSignal,
  /**
   * The registry trip's deadline (default 5s). The first load, whose late
   * answer still wins (withLateRead), passes its grace here so a slow registry
   * read is not cancelled before it can land. The second stage (groups, users,
   * roles) always has 5s per read, so a hung name read settles fast.
   */
  registryTimeoutMs: number = READ_TIMEOUT_MS,
): Promise<Result<ChannelSummary[]>> {
  const trip = <T>(
    run: (tripSignal: AbortSignal) => Promise<Result<T>>,
    timeoutMs: number = READ_TIMEOUT_MS,
  ): Promise<Result<T>> =>
    withReadTimeout((tripSignal) => withLinkedSignal(tripSignal, signal, run), timeoutMs);
  const channelsRes = await trip(async (tripSignal) => {
    const res = await abortable(
      client
        .from('chat_channels')
        .select(
          'channel_id, channel_type, entity_id, agora_group_id, dm_user_a, dm_user_b, created_at',
        )
        .eq('workspace_id', params.workspaceId)
        .order('created_at', { ascending: false }),
      tripSignal,
    );
    if (res.error)
      return fail<ChatChannelRow[]>(`listChannelSummaries channels: ${res.error.message}`);
    return { ok: true, data: (res.data ?? []) as ChatChannelRow[] };
  }, registryTimeoutMs);
  if (!channelsRes.ok) return channelsRes;
  const channels = channelsRes.data;
  mark('chat:roster:registry');

  const groupIds = unique(
    channels.filter((c) => c.channel_type === 'group').map((c) => c.entity_id),
  );
  const peerIds = unique(
    channels.filter((c) => c.channel_type === 'dm').map((c) => dmPeerId(c, params.currentUserId)),
  );

  const [groupsRes, usersRes, rolesRes] = await Promise.all([
    trip((s) => readGroups(client, groupIds, s)),
    trip((s) => readUsers(client, peerIds, s)),
    trip((s) => readMemberRoles(client, params.workspaceId, peerIds, s)),
  ]);
  mark('chat:roster:stage2');
  if (!groupsRes.ok) return groupsRes;
  if (!rolesRes.ok) return rolesRes;
  // The DM peers' names are a name read: its failure never fails the list
  // (those rows keep their neutral label until the next re-read).
  const users = usersRes.ok ? usersRes.data : [];

  return {
    ok: true,
    data: shapeChannelSummaries(
      channels,
      indexBy(groupsRes.data, (g) => g.id),
      indexBy(users, (u) => u.id),
      params.currentUserId,
      new Map(rolesRes.data.map((m) => [m.user_id, m.role])),
    ),
  };
}

/** Batched profile read for an arbitrary set of user ids (thread senders). */
export async function readProfiles(
  client: Client,
  userIds: string[],
  signal?: AbortSignal,
): Promise<Result<ChatProfile[]>> {
  const res = await readUsers(client, unique(userIds), signal);
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((u) => {
      // Typed NOT NULL, but a row read without the column carries none.
      const optIn: unknown = u.email_opt_in;
      return {
        userId: u.id,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        username: u.username ?? null,
        ...(typeof optIn === 'boolean' ? { emailOptIn: optIn } : {}),
      };
    }),
  };
}

/** A mentioned person's profile, and whether they are a current workspace member. */
export interface MentionProfile extends ChatProfile {
  /**
   * An active, non-removed workspace_members row in this workspace; null when
   * the membership read failed (unknown: nobody is marked former for it).
   */
  member: boolean | null;
}

/**
 * The ids among `userIds` with an active, non-removed membership in this
 * workspace: one batched workspace_members IN read (readChatMembers' filter).
 */
async function readActiveMemberIds(
  client: Client,
  params: { workspaceId: string; userIds: string[]; signal?: AbortSignal },
): Promise<Result<string[]>> {
  const res = await readMemberRoles(
    client,
    params.workspaceId,
    unique(params.userIds),
    params.signal,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.map((m) => m.user_id) };
}

/**
 * Profiles for mentioned ids, each marked with current membership: the users
 * IN read and the workspace_members IN read run in the same pass (users RLS
 * lets an ex-member's profile be read, so a name alone proves nothing). Only a
 * failed users read fails the whole read; a failed membership read still
 * returns the profiles, with membership unknown (null).
 */
export async function readMentionProfiles(
  client: Client,
  params: { workspaceId: string; userIds: string[]; signal?: AbortSignal; timeoutMs?: number },
): Promise<Result<MentionProfile[]>> {
  // With timeoutMs each read gets its own budget (in parallel), so a hung
  // membership read cannot take the profiles down with it.
  const bounded = <T>(run: (signal?: AbortSignal) => Promise<Result<T>>): Promise<Result<T>> =>
    params.timeoutMs !== undefined ? withReadTimeout(run, params.timeoutMs) : run(params.signal);
  const [profiles, active] = await Promise.all([
    bounded((signal) => readProfiles(client, params.userIds, signal)),
    bounded((signal) =>
      readActiveMemberIds(client, {
        workspaceId: params.workspaceId,
        userIds: params.userIds,
        ...(signal !== undefined ? { signal } : {}),
      }),
    ),
  ]);
  if (!profiles.ok) return profiles;
  if (!active.ok) return { ok: true, data: profiles.data.map((p) => ({ ...p, member: null })) };
  const members = new Set(active.data);
  return {
    ok: true,
    data: profiles.data.map((p) => ({ ...p, member: members.has(p.userId) })),
  };
}

/**
 * The Sorted user ids of one group's current members. A single RLS-scoped read
 * of group_members (no per-member round-trip); callers enrich with readProfiles
 * for display. Used by the group management panel to list members and to exclude
 * existing members from the add-member picker.
 */
export async function listGroupMemberIds(
  client: Client,
  params: { groupId: string; signal?: AbortSignal },
): Promise<Result<string[]>> {
  const query = client.from('group_members').select('user_id').eq('group_id', params.groupId);
  const res = await abortable(query, params.signal);
  if (res.error) return fail(`listGroupMemberIds: ${res.error.message}`);
  const rows = (res.data ?? []) as Pick<GroupMemberRow, 'user_id'>[];
  return { ok: true, data: rows.map((r) => r.user_id) };
}

/** A chat member the mention picker offers: display info plus workspace role. */
export interface ChatMember extends ChatProfile {
  /** The raw workspace_members.role; labelled at render. */
  role: string;
}

/**
 * Resolve chat member ids to picker rows: one batched users read and one batched
 * workspace_members read (active, not removed). An id with no active membership
 * or no profile is left out, so a removed member is never offered.
 */
export async function readChatMembers(
  client: Client,
  params: { workspaceId: string; userIds: string[]; signal?: AbortSignal },
): Promise<Result<ChatMember[]>> {
  const ids = unique(params.userIds);
  const [usersRes, rolesRes] = await Promise.all([
    readUsers(client, ids, params.signal),
    readMemberRoles(client, params.workspaceId, ids, params.signal),
  ]);
  if (!usersRes.ok) return usersRes;
  if (!rolesRes.ok) return rolesRes;
  const roleOf = new Map(rolesRes.data.map((m) => [m.user_id, m.role]));
  const members: ChatMember[] = [];
  for (const u of usersRes.data) {
    const role = roleOf.get(u.id);
    if (role === undefined) continue;
    members.push({
      userId: u.id,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
      username: u.username ?? null,
      role,
    });
  }
  return { ok: true, data: members };
}

/**
 * The ids a chat's mentions may name right now, the server's own membership
 * rule: a group's members, or a DM's two people, with an active workspace
 * membership. Three batched reads (the channel row, its members, their active
 * memberships) under one 5s timeout. Used to re-check mentions after the
 * server refused one; a failure is a failed Result, never a guess.
 */
export async function readChannelMemberIds(
  client: Client,
  params: { channelId: string },
): Promise<Result<string[]>> {
  return withReadTimeout(async (signal) => {
    const channelRes = await client
      .from('chat_channels')
      .select('workspace_id, channel_type, entity_id, dm_user_a, dm_user_b')
      .eq('channel_id', params.channelId)
      .abortSignal(signal)
      .maybeSingle();
    if (channelRes.error) return fail(`readChannelMemberIds channel: ${channelRes.error.message}`);
    const row = channelRes.data as Pick<
      ChatChannelRow,
      'workspace_id' | 'channel_type' | 'entity_id' | 'dm_user_a' | 'dm_user_b'
    > | null;
    if (row === null) return fail('readChannelMemberIds: channel not found');
    let ids: string[];
    if (row.channel_type === 'group') {
      if (row.entity_id === null) return { ok: true, data: [] };
      const members = await listGroupMemberIds(client, { groupId: row.entity_id, signal });
      if (!members.ok) return members;
      ids = unique(members.data);
    } else if (row.channel_type === 'dm') {
      ids = unique([row.dm_user_a, row.dm_user_b]);
    } else if (row.channel_type === 'notes') {
      // Notes name nobody: a save sends no mentions.
      return { ok: true, data: [] };
    } else {
      return fail(`readChannelMemberIds: no mention rule for ${row.channel_type}`);
    }
    const active = await readMemberRoles(client, row.workspace_id, ids, signal);
    if (!active.ok) return active;
    return { ok: true, data: active.data.map((m) => m.user_id) };
  });
}

/** One "delete chat for me" row: when the caller cleared a channel. */
interface ChannelClearRecord {
  channelId: string;
  clearedAt: string;
}

/**
 * The caller's chat_channel_clears rows for a workspace. RLS scopes the read to
 * the caller's own rows, so no user filter is passed. The list hides a channel
 * whose newest known message is not newer than its clear. 5s timeout, aborted
 * when it fires.
 */
export function listChannelClears(
  client: Client,
  params: { workspaceId: string },
): Promise<Result<ChannelClearRecord[]>> {
  return withReadTimeout((signal) => readChannelClears(client, params, signal));
}

/** The clears read itself, unbounded; `signal` cancels it. */
export async function readChannelClears(
  client: Client,
  params: { workspaceId: string },
  signal?: AbortSignal,
): Promise<Result<ChannelClearRecord[]>> {
  const res = await abortable(
    client
      .from('chat_channel_clears')
      .select('channel_id, cleared_at')
      .eq('workspace_id', params.workspaceId),
    signal,
  );
  if (res.error) return fail(`listChannelClears: ${res.error.message}`);
  const rows = (res.data ?? []) as Pick<ChannelClearRow, 'channel_id' | 'cleared_at'>[];
  return {
    ok: true,
    data: rows.map((r) => ({ channelId: r.channel_id, clearedAt: r.cleared_at })),
  };
}

/**
 * Run with one signal that fires when either does (a trip's deadline, or the
 * caller's cancel). The listeners it adds are removed when `run` settles, so a
 * long-lived cancel signal (a thread's card cache) never piles them up.
 */
export async function withLinkedSignal<T>(
  a: AbortSignal,
  b: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (b === undefined) return run(a);
  const both = new AbortController();
  const fire = (): void => both.abort();
  if (a.aborted || b.aborted) both.abort();
  a.addEventListener('abort', fire);
  b.addEventListener('abort', fire);
  try {
    return await run(both.signal);
  } finally {
    a.removeEventListener('abort', fire);
    b.removeEventListener('abort', fire);
  }
}

async function readGroups(
  client: Client,
  ids: string[],
  signal?: AbortSignal,
): Promise<Result<GroupRow[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const res = await abortable(
    client.from('groups').select('id, name, workspace_id, avatar_url, created_by').in('id', ids),
    signal,
  );
  if (res.error) return fail(`listChannelSummaries groups: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as GroupRow[] };
}

/** The users columns readUsers selects: one query, the profile slice plus email_opt_in. */
export const READ_USERS_COLUMNS = 'id, display_name, avatar_url, username, email_opt_in';

async function readUsers(
  client: Client,
  ids: string[],
  signal?: AbortSignal,
): Promise<Result<UserRow[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const res = await abortable(
    client.from('users').select(READ_USERS_COLUMNS).in('id', ids),
    signal,
  );
  if (res.error) return fail(`readProfiles users: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as UserRow[] };
}

/**
 * One batched read of the peers' active memberships in this workspace (active and
 * not removed, the Members panel's definition). No embed, no per-row query.
 */
async function readMemberRoles(
  client: Client,
  workspaceId: string,
  userIds: string[],
  signal?: AbortSignal,
): Promise<Result<Pick<WorkspaceMemberRow, 'user_id' | 'role'>[]>> {
  if (userIds.length === 0) return { ok: true, data: [] };
  const query = client
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .is('removed_at', null)
    .in('user_id', userIds);
  const res = await abortable(query, signal);
  if (res.error) return fail(`listChannelSummaries members: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as Pick<WorkspaceMemberRow, 'user_id' | 'role'>[] };
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}
