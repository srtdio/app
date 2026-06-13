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

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

type ChatChannelRow = Database['public']['Tables']['chat_channels']['Row'];
type GroupRow = Database['public']['Tables']['groups']['Row'];
type UserRow = Database['public']['Tables']['users']['Row'];

/** A user's display info, the slice the chat UI shows. */
export interface ChatProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** One conversation in the channel list, with display info already resolved. */
export interface ChannelSummary {
  channelId: string;
  channelType: 'dm' | 'group';
  /** Title shown in the list: group name or the DM peer's display name. */
  title: string;
  /** Avatar src for a DM peer; groups have none in the MVP. */
  avatarUrl: string | null;
  /** The Agora group id for group channels; null until the sync worker stamps it. */
  agoraGroupId: string | null;
  /** The DM peer's Sorted user id (the participant who is not the current user). */
  peerUserId: string | null;
  createdAt: string;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
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
 * (keyed by entity_id), DM channels take the peer's name/avatar from usersById.
 * Unknown ids fall back to a neutral label so a missing row never blanks the row.
 */
export function shapeChannelSummaries(
  channels: ChatChannelRow[],
  groupsById: Map<string, GroupRow>,
  usersById: Map<string, UserRow>,
  currentUserId: string,
): ChannelSummary[] {
  return channels.map((channel) => {
    if (channel.channel_type === 'group') {
      const group = channel.entity_id !== null ? groupsById.get(channel.entity_id) : undefined;
      return {
        channelId: channel.channel_id,
        channelType: 'group',
        title: group?.name ?? 'Group',
        avatarUrl: null,
        agoraGroupId: channel.agora_group_id,
        peerUserId: null,
        createdAt: channel.created_at,
      };
    }
    const peerId = dmPeerId(channel, currentUserId);
    const peer = peerId !== null ? usersById.get(peerId) : undefined;
    return {
      channelId: channel.channel_id,
      channelType: 'dm',
      title: peer?.display_name ?? 'Direct message',
      avatarUrl: peer?.avatar_url ?? null,
      agoraGroupId: channel.agora_group_id,
      peerUserId: peerId,
      createdAt: channel.created_at,
    };
  });
}

function indexBy<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return map;
}

/**
 * List a workspace's chat channels, newest first, each enriched with display
 * info. Three round-trips total regardless of channel count: the channel
 * registry, then one batched groups read and one batched users read. Last-message
 * preview and unread counts are a later enhancement and are not built here.
 */
export async function listChannelSummaries(
  client: Client,
  params: { workspaceId: string; currentUserId: string },
): Promise<Result<ChannelSummary[]>> {
  const channelsRes = await client
    .from('chat_channels')
    .select('channel_id, channel_type, entity_id, agora_group_id, dm_user_a, dm_user_b, created_at')
    .eq('workspace_id', params.workspaceId)
    .order('created_at', { ascending: false });
  if (channelsRes.error) return fail(`listChannelSummaries channels: ${channelsRes.error.message}`);
  const channels = (channelsRes.data ?? []) as ChatChannelRow[];

  const groupIds = unique(
    channels.filter((c) => c.channel_type === 'group').map((c) => c.entity_id),
  );
  const peerIds = unique(
    channels.filter((c) => c.channel_type === 'dm').map((c) => dmPeerId(c, params.currentUserId)),
  );

  const groupsRes = await readGroups(client, groupIds);
  if (!groupsRes.ok) return groupsRes;
  const usersRes = await readUsers(client, peerIds);
  if (!usersRes.ok) return usersRes;

  return {
    ok: true,
    data: shapeChannelSummaries(
      channels,
      indexBy(groupsRes.data, (g) => g.id),
      indexBy(usersRes.data, (u) => u.id),
      params.currentUserId,
    ),
  };
}

/** Batched profile read for an arbitrary set of user ids (thread senders). */
export async function readProfiles(
  client: Client,
  userIds: string[],
): Promise<Result<ChatProfile[]>> {
  const res = await readUsers(client, unique(userIds));
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((u) => ({
      userId: u.id,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
    })),
  };
}

async function readGroups(client: Client, ids: string[]): Promise<Result<GroupRow[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const res = await client.from('groups').select('id, name, workspace_id').in('id', ids);
  if (res.error) return fail(`listChannelSummaries groups: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as GroupRow[] };
}

async function readUsers(client: Client, ids: string[]): Promise<Result<UserRow[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const res = await client.from('users').select('id, display_name, avatar_url').in('id', ids);
  if (res.error) return fail(`readProfiles users: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as UserRow[] };
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}
