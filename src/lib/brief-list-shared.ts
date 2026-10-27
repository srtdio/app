// The Briefs list's shared session reads (src/lib/session-read.ts): the first
// page and the chip counts, joined by key between a nav press and the page's
// mount, and the kept list (every page loaded, thumbnails filled) that a
// return to Briefs paints at once before it refreshes quietly. Kept apart from
// brief-list.ts, whose pure readers the briefs DB suite imports without the
// app's client, logger or session state.

import { mark } from '@/lib/perf-marks';
import type { Brief, BriefWithThumbnail } from '@srtdio/briefs';
import type { Client, Result } from '@srtdio/rpc';
import { countBriefsByFilter } from '@/lib/brief-counts';
import {
  listBriefsFirstPage,
  mergeBriefPages,
  type BriefCursor,
  type BriefFilter,
  type BriefPageNext,
  type BriefsFirstPage,
} from '@/lib/brief-list';
import { toExternalLinks } from '@/lib/links';
import type { PrefetchContext } from '@/lib/prefetch-context';
import { invalidateReads, peekKept, primeRead, readKey, sharedRead } from '@/lib/session-read';

/**
 * Whether the first paint must wait for the thumbnails: true when a loaded
 * brief carries a reference link (its card shows the link only when there is
 * no image, so the card's height depends on the thumbnail). Pure.
 */
export function briefsPaintNeedsThumbs(briefs: readonly Pick<Brief, 'reference_links'>[]): boolean {
  return briefs.some((brief) => toExternalLinks(brief.reference_links).length > 0);
}

/** The session key prefix of every Briefs list read for this user and workspace. */
function briefsKeyPrefix(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'briefs:');
}

/**
 * The first page, joined with one already running or just settled. `read` is
 * the page reader (the page passes its own import, so its tests can stand in
 * for the network); the key, not the reader, is what joins.
 */
export function readBriefsFirstPage(
  client: Client,
  userId: string,
  workspaceId: string,
  read: typeof listBriefsFirstPage = listBriefsFirstPage,
): Promise<Result<BriefsFirstPage>> {
  const key = `${briefsKeyPrefix(userId, workspaceId)}first-page`;
  return sharedRead(key, () => read(client, workspaceId), { isOk: (result) => result.ok });
}

function briefCountsKey(userId: string, workspaceId: string, search: string): string {
  return `${briefsKeyPrefix(userId, workspaceId)}counts:${search}`;
}

/** The chip counts for a search, joined with a read already running or just settled. */
export function readBriefCounts(
  client: Client,
  userId: string,
  workspaceId: string,
  search: string,
  read: typeof countBriefsByFilter = countBriefsByFilter,
): ReturnType<typeof countBriefsByFilter> {
  const key = briefCountsKey(userId, workspaceId, search);
  return sharedRead(key, () => read(client, workspaceId, search), { isOk: (result) => result.ok });
}

/** Mark every shared Briefs list read stale (a reload, a create): the next read asks again. */
export function staleBriefsReads(userId: string, workspaceId: string): void {
  invalidateReads(briefsKeyPrefix(userId, workspaceId));
}

/** The list as the page paints it: every loaded page, thumbnails filled. */
export interface KeptBriefs {
  items: BriefWithThumbnail[];
  next: BriefPageNext;
}

function briefsListKey(userId: string, workspaceId: string): string {
  return `${briefsKeyPrefix(userId, workspaceId)}list`;
}

/** The list this session last painted, at any age; never reads. */
export function keptBriefsList(userId: string, workspaceId: string): KeptBriefs | undefined {
  return peekKept<KeptBriefs>(briefsListKey(userId, workspaceId));
}

/** Keep the list the page shows (a load, Load more, a quiet refresh) for the next visit. */
export function primeBriefsList(userId: string, workspaceId: string, list: KeptBriefs): void {
  primeRead(briefsListKey(userId, workspaceId), list);
}

/** The unsearched chip counts this session last read, at any age; never reads. */
export function keptBriefCounts(
  userId: string,
  workspaceId: string,
): Record<BriefFilter, number> | undefined {
  const kept = peekKept<Result<Record<BriefFilter, number>>>(
    briefCountsKey(userId, workspaceId, ''),
  );
  return kept !== undefined && kept.ok ? kept.data : undefined;
}

/** Whether `brief` sorts after `cursor` (created_at desc, id desc), as the keyset reads. */
function pastCursor(brief: BriefWithThumbnail, cursor: BriefCursor): boolean {
  if (brief.created_at !== cursor.createdAt) return brief.created_at < cursor.createdAt;
  return brief.id < cursor.id;
}

/**
 * A refreshed first page laid over the kept list: the fresh rows, then the
 * kept rows past the fresh page's end (the older pages the person loaded), so
 * a quiet refresh never shortens the list under the restored scroll. Pure.
 */
export function withKeptBriefsTail(fresh: KeptBriefs, kept: KeptBriefs): KeptBriefs {
  if (fresh.next.done) return fresh;
  const { cursor } = fresh.next;
  const tail = kept.items.filter((brief) => pastCursor(brief, cursor));
  if (tail.length === 0) return fresh;
  return { items: mergeBriefPages(fresh.items, tail), next: kept.next };
}

/**
 * Nav-press starter (src/lib/route-data.ts): the first page (its thumbnails
 * chained on) and the unsearched chip counts. Paints nothing; never throws.
 * The client loads lazily so this module stays cheap for its pure importers.
 */
export function prefetchBriefsData(ctx: PrefetchContext): Promise<void> {
  mark('briefs:prefetch');
  return import('@/lib/supabase').then(
    ({ supabase }) => {
      const swallow = (): void => {};
      readBriefsFirstPage(supabase, ctx.userId, ctx.workspaceId).catch(swallow);
      readBriefCounts(supabase, ctx.userId, ctx.workspaceId, '').catch(swallow);
    },
    () => undefined,
  );
}
