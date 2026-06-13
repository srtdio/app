// Compliance / history read layer for the Postgres mirror of chat.
//
// These are plain RLS-scoped SELECTs through the supabase client, mirroring
// src/lib/assets.ts and @srtdio/comments: no proc, no service role, tenant
// isolation is Postgres' job and the explicit workspace_id filter pins each
// query to the per-workspace indexes. A transport/PostgREST failure surfaces as
// { ok: false } rather than a throw, matching the @srtdio wrappers.
//
// The live chat read path is the Agora SDK, not these helpers. The
// chat_channels / chat_messages tables are a webhook-fed mirror kept for
// compliance and history only; never read them for the live conversation view.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

/** A channel row (both dm and group), exactly as mirrored. */
export type ChatChannelRow = Database['public']['Tables']['chat_channels']['Row'];

/** A mirrored chat message row, exactly as stored. */
export type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row'];

/** Page size for the message read. Fixed; not caller-tunable. Mirrors comments. */
export const PAGE_SIZE = 50;

function transportError(message: string): Result<never> {
  return { ok: false, error: { code: 'unknown', message } };
}

export interface ListChannelsInput {
  workspace_id: string;
}

/**
 * List every mirrored channel in one workspace. Ordered created_at ascending,
 * with channel_id ascending as a stable tiebreaker so the order is fully
 * deterministic when two channels share a created_at. RLS confines the read to
 * the caller's workspaces; the explicit workspace_id filter pins the index.
 */
export async function listChannels(
  client: Client,
  input: ListChannelsInput,
): Promise<Result<ChatChannelRow[]>> {
  const { data, error } = await client
    .from('chat_channels')
    .select('*')
    .eq('workspace_id', input.workspace_id)
    .order('created_at', { ascending: true })
    .order('channel_id', { ascending: true });

  if (error) return transportError(error.message);
  return { ok: true, data: data ?? [] };
}

export interface ListMessagesInput {
  workspace_id: string;
  channel_id: string;
  /** Zero-based page index; PAGE_SIZE rows per page. */
  page?: number;
}

/**
 * List the mirrored messages of one channel, newest first, one page at a time.
 * Soft-deleted rows are excluded. Paginated exactly like listComments (a single
 * ranged query, never a per-row fetch loop), so a busy channel never full-loads.
 */
export async function listMessages(
  client: Client,
  input: ListMessagesInput,
): Promise<Result<ChatMessageRow[]>> {
  const page = Math.max(0, input.page ?? 0);
  const start = page * PAGE_SIZE;

  const { data, error } = await client
    .from('chat_messages')
    .select('*')
    .eq('workspace_id', input.workspace_id)
    .eq('channel_id', input.channel_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(start, start + PAGE_SIZE - 1);

  if (error) return transportError(error.message);
  return { ok: true, data: data ?? [] };
}

// ---------------------------------------------------------------------------
// Channel display resolution (registry, not mirror).
//
// The channel list reads chat_channels (the Sorted registry) and enriches each
// row with a human label: a group's name, or a DM peer's profile. Both lookups
// are single batched IN-clause reads keyed on the ids gathered across all
// channels, so the list never fans out into a per-row fetch loop.
// ---------------------------------------------------------------------------

/** A group's display name, typed from the generated Row. */
export type GroupNameRow = Pick<Database['public']['Tables']['groups']['Row'], 'id' | 'name'>;

/** A user's display profile, typed from the generated Row. */
export type UserProfileRow = Pick<
  Database['public']['Tables']['users']['Row'],
  'id' | 'display_name' | 'avatar_url'
>;

/** A channel resolved to what the list renders: a label and an optional avatar. */
export interface ChannelSummary {
  channel: ChatChannelRow;
  kind: 'group' | 'dm';
  title: string;
  avatarUrl: string | null;
}

/** Fetch group names for the given ids in one IN-clause read. */
export async function listGroupsByIds(
  client: Client,
  input: { ids: string[] },
): Promise<Result<GroupNameRow[]>> {
  if (input.ids.length === 0) return { ok: true, data: [] };
  const { data, error } = await client
    .from('groups')
    .select('id, name')
    .in('id', input.ids)
    .is('deleted_at', null);

  if (error) return transportError(error.message);
  return { ok: true, data: data ?? [] };
}

/** Fetch user display profiles for the given ids in one IN-clause read. */
export async function listProfilesByIds(
  client: Client,
  input: { ids: string[] },
): Promise<Result<UserProfileRow[]>> {
  if (input.ids.length === 0) return { ok: true, data: [] };
  const { data, error } = await client
    .from('users')
    .select('id, display_name, avatar_url')
    .in('id', input.ids)
    .is('deleted_at', null);

  if (error) return transportError(error.message);
  return { ok: true, data: data ?? [] };
}

export interface ResolveChannelSummariesInput {
  channels: ChatChannelRow[];
  currentUserId: string;
}

/**
 * Resolve display info for a set of channels with exactly two batched reads (one
 * for every group name, one for every DM peer profile), preserving input order.
 * Group label = groups.name; DM label = the peer's display_name (peer = the side
 * that is not the current user). Falls back to a generic label when a referenced
 * group or profile is absent so the list still renders.
 */
export async function resolveChannelSummaries(
  client: Client,
  input: ResolveChannelSummariesInput,
): Promise<Result<ChannelSummary[]>> {
  const groupIds = collectGroupIds(input.channels);
  const peerIds = collectPeerIds(input.channels, input.currentUserId);

  const [groups, profiles] = await Promise.all([
    listGroupsByIds(client, { ids: groupIds }),
    listProfilesByIds(client, { ids: peerIds }),
  ]);
  if (!groups.ok) return groups;
  if (!profiles.ok) return profiles;

  const ctx: SummaryContext = {
    currentUserId: input.currentUserId,
    groupName: new Map(groups.data.map((g) => [g.id, g.name])),
    profile: new Map(profiles.data.map((p) => [p.id, p])),
  };
  return { ok: true, data: input.channels.map((channel) => summarize(channel, ctx)) };
}

function collectGroupIds(channels: ChatChannelRow[]): string[] {
  const ids = new Set<string>();
  for (const channel of channels) {
    if (channel.channel_type === 'group' && channel.entity_id !== null) ids.add(channel.entity_id);
  }
  return [...ids];
}

function collectPeerIds(channels: ChatChannelRow[], currentUserId: string): string[] {
  const ids = new Set<string>();
  for (const channel of channels) {
    const peer = dmPeer(channel, currentUserId);
    if (peer !== null) ids.add(peer);
  }
  return [...ids];
}

/** The DM peer id, or null for group channels and malformed DM rows. */
function dmPeer(channel: ChatChannelRow, currentUserId: string): string | null {
  if (channel.channel_type !== 'dm') return null;
  return channel.dm_user_a === currentUserId ? channel.dm_user_b : channel.dm_user_a;
}

interface SummaryContext {
  currentUserId: string;
  groupName: Map<string, string>;
  profile: Map<string, UserProfileRow>;
}

function summarize(channel: ChatChannelRow, ctx: SummaryContext): ChannelSummary {
  if (channel.channel_type === 'group') {
    const name = channel.entity_id !== null ? ctx.groupName.get(channel.entity_id) : undefined;
    return { channel, kind: 'group', title: name ?? 'Group', avatarUrl: null };
  }
  const peer = dmPeer(channel, ctx.currentUserId);
  const found = peer !== null ? ctx.profile.get(peer) : undefined;
  return {
    channel,
    kind: 'dm',
    title: found?.display_name ?? 'Direct message',
    avatarUrl: found?.avatar_url ?? null,
  };
}
