// Read and create helpers for a workspace's post buckets (the colored columns a
// post can be filed under). The read is a plain RLS-scoped SELECT through the
// supabase client, mirroring the @srtdio reads and src/lib/assets.ts; the create
// is workspace_bucket_create with an explicit p_trace_id. Tenant isolation is
// Postgres' job. The shaping (`shapeBuckets`) is pure so the
// archived filter + position ordering are unit-tested without a database.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

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

/** workspace_bucket_create's name limit (1 to 40 characters after trim). */
export const BUCKET_NAME_MAX = 40;

/**
 * User-facing copy for a workspace_bucket_create failure. Only the two known
 * codes get their own line; anything else (network, permission) is generic so
 * raw Postgres text never reaches the screen. Pure.
 */
export function bucketCreateErrorMessage(message: string): string {
  if (message.includes('name_taken')) return "That name's already taken.";
  if (message.includes('invalid_name')) return 'Use 1 to 40 characters.';
  return "Couldn't create the bucket. Try again.";
}

type CreateArgs = Database['public']['Functions']['workspace_bucket_create']['Args'];

/**
 * Create a bucket (workspace_bucket_create, explicit p_trace_id, the same shape
 * as chat_task_create), then read its row back so the picker gets the color and
 * position the proc assigned. A failure carries the friendly copy as its
 * message; never throws.
 */
export async function createBucket(
  client: Client,
  workspaceId: string,
  name: string,
  traceId: string,
): Promise<Result<BucketOption>> {
  const args: CreateArgs = {
    p_workspace_id: workspaceId,
    p_name: name.trim(),
    p_trace_id: traceId,
  };
  try {
    const { data, error } = await client.rpc('workspace_bucket_create', args);
    if (error) {
      return {
        ok: false,
        error: { code: 'unknown', message: bucketCreateErrorMessage(error.message) },
      };
    }
    if (typeof data !== 'string' || data === '') {
      return { ok: false, error: { code: 'unknown', message: bucketCreateErrorMessage('') } };
    }
    const row = await client
      .from('workspace_buckets')
      .select('id, name, color_hex, position, archived')
      .eq('id', data)
      .single();
    if (row.error || row.data === null) {
      return { ok: false, error: { code: 'unknown', message: bucketCreateErrorMessage('') } };
    }
    const shaped = shapeBuckets([row.data as unknown as RawBucketRow])[0];
    return shaped !== undefined
      ? { ok: true, data: shaped }
      : { ok: false, error: { code: 'unknown', message: bucketCreateErrorMessage('') } };
  } catch {
    return { ok: false, error: { code: 'unknown', message: bucketCreateErrorMessage('') } };
  }
}
