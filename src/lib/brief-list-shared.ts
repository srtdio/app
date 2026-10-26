// The Briefs list's shared session reads (src/lib/session-read.ts): the first
// page and the chip counts, joined by key between a nav press and the page's
// mount. Kept apart from brief-list.ts, whose pure readers the briefs DB suite
// imports without the app's client, logger or session state.

import type { Client, Result } from '@srtdio/rpc';
import { countBriefsByFilter } from '@/lib/brief-counts';
import { listBriefsFirstPage, type BriefsFirstPage } from '@/lib/brief-list';
import type { PrefetchContext } from '@/lib/prefetch-context';
import { invalidateReads, readKey, sharedRead } from '@/lib/session-read';

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

/** The chip counts for a search, joined with a read already running or just settled. */
export function readBriefCounts(
  client: Client,
  userId: string,
  workspaceId: string,
  search: string,
  read: typeof countBriefsByFilter = countBriefsByFilter,
): ReturnType<typeof countBriefsByFilter> {
  const key = `${briefsKeyPrefix(userId, workspaceId)}counts:${search}`;
  return sharedRead(key, () => read(client, workspaceId, search), { isOk: (result) => result.ok });
}

/** Forget every shared Briefs list read (a reload, a create, the page leaving). */
export function dropBriefsReads(userId: string, workspaceId: string): void {
  invalidateReads(briefsKeyPrefix(userId, workspaceId));
}

/**
 * Nav-press starter (src/lib/route-data.ts): the first page (its thumbnails
 * chained on) and the unsearched chip counts. Paints nothing; never throws.
 * The client loads lazily so this module stays cheap for its pure importers.
 */
export function prefetchBriefsData(ctx: PrefetchContext): Promise<void> {
  return import('@/lib/supabase').then(
    ({ supabase }) => {
      const swallow = (): void => {};
      readBriefsFirstPage(supabase, ctx.userId, ctx.workspaceId).catch(swallow);
      readBriefCounts(supabase, ctx.userId, ctx.workspaceId, '').catch(swallow);
    },
    () => undefined,
  );
}
