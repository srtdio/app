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
