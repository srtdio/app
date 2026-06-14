// Read helper for a workspace's post buckets (the colored columns a post can be
// filed under). A plain RLS-scoped SELECT through the supabase client, mirroring
// the @srtdio reads and src/lib/assets.ts: no proc, no service role, tenant
// isolation is Postgres' job. The shaping (`shapeBuckets`) is pure so the
// archived filter + position ordering are unit-tested without a database.

import type { Client, Result } from '@srtdio/rpc';

/** One selectable, non-archived bucket, shaped for the picker and the dot. */
export interface BucketOption {
  id: string;
  name: string;
  /** workspace_buckets.color_hex; rendered as the dot's background (data, not a literal). */
  colorHex: string;
  position: number;
}

/** The columns selected below, before shaping. */
interface RawBucketRow {
  id: string;
  name: string;
  color_hex: string;
  position: number;
  archived: boolean;
}

/**
 * Drop archived buckets, order by position ascending, and flatten to the option
 * shape. Pure: the archived filter is re-applied here (defence in depth over the
 * query's own filter) so a stray archived row can never reach the picker.
 */
export function shapeBuckets(rows: RawBucketRow[]): BucketOption[] {
  return rows
    .filter((row) => !row.archived)
    .map((row) => ({
      id: row.id,
      name: row.name,
      colorHex: row.color_hex,
      position: row.position,
    }))
    .sort((a, b) => a.position - b.position);
}

/**
 * List a workspace's non-archived buckets in display (position) order. Returns
 * an empty array (never null) when there are none; a transport/PostgREST failure
 * surfaces as { ok: false } rather than a throw, matching the @srtdio wrappers.
 */
export async function listBuckets(
  client: Client,
  workspaceId: string,
): Promise<Result<BucketOption[]>> {
  const res = await client
    .from('workspace_buckets')
    .select('id, name, color_hex, position, archived')
    .eq('workspace_id', workspaceId)
    .eq('archived', false)
    .order('position', { ascending: true });
  if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
  return { ok: true, data: shapeBuckets((res.data ?? []) as unknown as RawBucketRow[]) };
}
