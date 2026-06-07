// The brief read layer: plain RLS-scoped SELECTs, no proc involved. Tenant
// isolation is Postgres' job (the caller's JWT drives RLS), so these functions
// add no membership checks of their own. Results are wrapped in the same Result
// shape the write wrappers use, so callers branch uniformly; a transport/Postgrest
// failure surfaces as a { code: 'unknown' } error rather than a throw.

import type { Client, DomainError, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

export type Brief = Database['public']['Tables']['briefs']['Row'];

/** Default page size for {@link listBriefs}. */
export const BRIEFS_PAGE_SIZE = 50;

export interface ListBriefsFilters {
  /** Restrict to open or closed briefs. */
  status?: 'open' | 'closed';
  /** Restrict to briefs created by this user id. */
  createdBy?: string;
  /** Inclusive lower bound on target_date (ISO `YYYY-MM-DD`). */
  targetDateFrom?: string;
  /** Inclusive upper bound on target_date (ISO `YYYY-MM-DD`). */
  targetDateTo?: string;
  /** Page size. Defaults to {@link BRIEFS_PAGE_SIZE}. */
  limit?: number;
  /** Row offset for pagination. Defaults to 0. */
  offset?: number;
}

/** A brief plus its per-request derived count of live linked posts. */
export interface BriefWithLinkedCount {
  brief: Brief;
  /** count(*) of posts pointing at this brief, excluding soft-deleted ones. */
  linked_posts_count: number;
}

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}

/**
 * List briefs visible to the caller, newest first. Soft-deleted briefs are
 * excluded; the "recently deleted" surface is a separate concern.
 */
export async function listBriefs(
  client: Client,
  filters: ListBriefsFilters = {},
): Promise<Result<Brief[]>> {
  let query = client.from('briefs').select('*').is('deleted_at', null);
  if (filters.status !== undefined) query = query.eq('status', filters.status);
  if (filters.createdBy !== undefined) query = query.eq('created_by', filters.createdBy);
  if (filters.targetDateFrom !== undefined)
    query = query.gte('target_date', filters.targetDateFrom);
  if (filters.targetDateTo !== undefined) query = query.lte('target_date', filters.targetDateTo);

  const limit = filters.limit ?? BRIEFS_PAGE_SIZE;
  const offset = filters.offset ?? 0;

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data ?? [] };
}

/**
 * Fetch one brief by id together with a freshly derived linked_posts_count.
 * Returns `{ ok: true, data: null }` when the brief is absent or hidden by RLS.
 * The count is never stored; it is computed per request.
 */
export async function getBrief(
  client: Client,
  briefId: string,
): Promise<Result<BriefWithLinkedCount | null>> {
  const { data, error } = await client
    .from('briefs')
    .select('*')
    .eq('id', briefId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { ok: false, error: transportError(error.message) };
  if (data === null) return { ok: true, data: null };

  const countResult = await client
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .eq('brief_id', briefId)
    .is('deleted_at', null);
  if (countResult.error) return { ok: false, error: transportError(countResult.error.message) };

  return { ok: true, data: { brief: data, linked_posts_count: countResult.count ?? 0 } };
}
