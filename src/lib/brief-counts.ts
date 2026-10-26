// Real chip counts for the Briefs list. The list loads a keyset page at a time,
// so a count taken over loaded rows would stop at the page size; each chip's
// number is instead one HEAD count read on the server, with the list's own
// filters (live rows of the active workspace, under the same RLS) plus the
// chip's status and the typed title search. Never derived from loaded rows.

import type { Client, Result } from '@srtdio/rpc';
import type { BriefFilter } from '@/lib/brief-list';

/** The chips that carry a count, in the order the header renders them. */
export const BRIEF_COUNT_FILTERS: readonly BriefFilter[] = ['all', 'open', 'closed'];

/** One count per chip. */
type BriefCounts = Record<BriefFilter, number>;

/**
 * Escape LIKE metacharacters (backslash, %, _) so a typed search matches as
 * plain text, the way the in-memory title filter does. Pure.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The ILIKE pattern for a title search: a case-insensitive substring of the
 * trimmed query, the server twin of filterByTitle. A blank search is no filter
 * (null). Pure.
 */
export function briefTitlePattern(search: string): string | null {
  const query = search.trim();
  if (query === '') return null;
  return `%${escapeLikePattern(query)}%`;
}

/**
 * How many live briefs of the workspace sit under one chip (after the search):
 * one HEAD request, `select('id', { count: 'exact', head: true })`, so no row
 * is transferred. Same filters as listBriefsPage (deleted_at is null and the
 * workspace), plus status for Open / Closed and ILIKE on the title when a
 * search is typed.
 */
export async function countBriefs(
  client: Client,
  workspaceId: string,
  filter: BriefFilter,
  search: string,
): Promise<Result<number>> {
  try {
    let query = client
      .from('briefs')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null)
      .eq('workspace_id', workspaceId);
    if (filter !== 'all') query = query.eq('status', filter);
    const pattern = briefTitlePattern(search);
    if (pattern !== null) query = query.ilike('title', pattern);
    const { count, error } = await query;
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return { ok: true, data: count ?? 0 };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : 'count failed';
    return { ok: false, error: { code: 'unknown', message } };
  }
}

/**
 * Every chip's count, read in parallel (one HEAD request per chip, three in
 * all). Any failed read fails the whole set, so the header never mixes a real
 * count with a missing one.
 */
export async function countBriefsByFilter(
  client: Client,
  workspaceId: string,
  search: string,
): Promise<Result<BriefCounts>> {
  const results = await Promise.all(
    BRIEF_COUNT_FILTERS.map((filter) => countBriefs(client, workspaceId, filter, search)),
  );
  const counts: BriefCounts = { all: 0, open: 0, closed: 0 };
  for (const [index, filter] of BRIEF_COUNT_FILTERS.entries()) {
    const result = results[index];
    if (result === undefined) continue;
    if (!result.ok) return result;
    counts[filter] = result.data;
  }
  return { ok: true, data: counts };
}
