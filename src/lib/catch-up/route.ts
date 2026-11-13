// Catch up's route. Since 13 Nov 2026 it lives on each tab
// (<tab>?catchup=<kind>, lib/catch-up/tab-store); /activity?catchup=<entryId>
// and ?threads=1 are old links that redirect (oldCatchUpTarget). Back, refresh
// and deep links work. Opening pushes one history step; closing removes the param with
// replace (never a push), or returns to the screen a toast opened it from.
// A toast or a row hands over the entry it already holds (seedCatchUpEntry),
// so the first card paints from it without a read.

import type { ActivityItem } from '@/components/pages/activity/data';
import { itemOf } from '@/lib/catch-up/queue';
import { tabCatchUpHref, tabKindOf } from '@/lib/catch-up/tab-store';

/** The query param that opens catch up on Activity. */
export const CATCH_UP_PARAM = 'catchup';

/** The value that opens catch up from the newest unread (the Catch up bar). */
export const CATCH_UP_NEWEST = 'newest';

/** The value that opens the Threads button's queue (unread threads only) on the same screen. */
export const CATCH_UP_THREADS = 'threads';

/** The query param (value THREADS_LIST_ON) that opens Activity's Threads list (the Threads button). */
export const THREADS_LIST_PARAM = 'threads';
export const THREADS_LIST_ON = '1';

/** Activity's path. */
export const ACTIVITY_PATH = '/activity';

/** The link that opens catch up with `entryId` first. Pure. */
export function catchUpHref(entryId: string): string {
  return `${ACTIVITY_PATH}?${CATCH_UP_PARAM}=${encodeURIComponent(entryId)}`;
}

/** The router state a link carries so Done and Back return to its opener. */
export interface CatchUpReturnState {
  catchUpReturn: string;
}

/** The return path a location state carries, or null. Pure. */
export function catchUpReturnOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>).catchUpReturn;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The entries a row tap or toast handed over, by id (the first card paints from them). */
const seeds = new Map<string, { item: ActivityItem; follow: ActivityItem[] }>();

/** Hand over the entry (and a group head's other entries) a tap opens catch up with. */
export function seedCatchUpEntry(item: ActivityItem, follow: readonly ActivityItem[] = []): void {
  seeds.set(item.id, { item, follow: [...follow] });
}

/** The handed-over entry for `id`, once (it is forgotten as it is read). */
export function takeCatchUpSeed(
  id: string,
): { item: ActivityItem; follow: ActivityItem[] } | undefined {
  const seed = seeds.get(id);
  seeds.delete(id);
  return seed;
}

/**
 * Where an old Activity catch-up link lands (13 Nov 2026: catch up lives on
 * each tab). Threads (?threads=1, ?catchup=threads) and the old Catch up row
 * (?catchup=newest) open Chat catch up; an entry opens its item's tab with
 * that item first (the entry is handed over, so the first card paints from
 * it); an entry that is gone, or opens no card, lands on Activity. Pure but
 * for the hand-over.
 */
export function oldCatchUpTarget(input: {
  catchUp: string | null;
  threads: string | null;
  entry: ActivityItem | null;
}): string {
  const { catchUp } = input;
  if (catchUp === null || catchUp === CATCH_UP_THREADS || catchUp === CATCH_UP_NEWEST) {
    return catchUp === null && input.threads !== THREADS_LIST_ON
      ? ACTIVITY_PATH
      : tabCatchUpHref('chat');
  }
  const at = input.entry !== null ? itemOf(input.entry) : null;
  if (input.entry === null || at === null) return ACTIVITY_PATH;
  seedCatchUpEntry(input.entry);
  return tabCatchUpHref(tabKindOf(at.kind), input.entry.id);
}
