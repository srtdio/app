// Pure status filter for the Briefs surface. Search and sort are shared via
// list-sort; this covers the All / Open / Closed chips, the URL state they live
// in (?status=&q=), and the paged workspace read the list loads from.

import type { Brief, ListBriefsFilters } from '@srtdio/briefs';
import type { Result } from '@srtdio/rpc';
import type { BriefStatus } from '@/components/pages/BriefCard';

export type BriefFilter = 'all' | BriefStatus;

/** The chip the list opens on when the URL names none. */
export const BRIEF_FILTER_DEFAULT: BriefFilter = 'open';

/** Keep every brief for "all", otherwise only those matching the status. */
export function filterBriefsByStatus(briefs: Brief[], filter: BriefFilter): Brief[] {
  if (filter === 'all') return briefs;
  return briefs.filter((brief) => brief.status === filter);
}

/** The ?status= value as a filter; anything unknown or absent is the default (Open). */
export function parseBriefFilter(value: string | null): BriefFilter {
  return value === 'all' || value === 'open' || value === 'closed' ? value : BRIEF_FILTER_DEFAULT;
}

/**
 * The list's URL params for a filter and search: the default chip and an empty
 * search are left out, every other param is kept as it was. Pure.
 */
export function briefListParams(
  current: URLSearchParams,
  filter: BriefFilter,
  search: string,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (filter === BRIEF_FILTER_DEFAULT) next.delete('status');
  else next.set('status', filter);
  if (search === '') next.delete('q');
  else next.set('q', search);
  return next;
}

/** Most pages one load reads (50 each), so a runaway loop can never hang the list. */
export const BRIEF_PAGE_LIMIT = 40;

/**
 * Every brief in one workspace, read page by page on the server (workspace_id
 * filter, limit/offset) until a short page. A failed page fails the whole read.
 */
export async function listWorkspaceBriefs<T>(
  workspaceId: string,
  pageSize: number,
  readPage: (filters: ListBriefsFilters) => Promise<Result<T[]>>,
): Promise<Result<T[]>> {
  const all: T[] = [];
  for (let page = 0; page < BRIEF_PAGE_LIMIT; page += 1) {
    const result = await readPage({ workspaceId, limit: pageSize, offset: page * pageSize });
    if (!result.ok) return result;
    all.push(...result.data);
    if (result.data.length < pageSize) break;
  }
  return { ok: true, data: all };
}
