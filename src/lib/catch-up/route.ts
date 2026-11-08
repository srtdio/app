// Catch up's route: /activity?catchup=<entryId>, so Back, refresh and deep
// links work. Opening pushes one history step; closing removes the param with
// replace (never a push), or returns to the screen a toast opened it from.
// A toast or a row hands over the entry it already holds (seedCatchUpEntry),
// so the first card paints from it without a read.

import type { ActivityItem } from '@/components/pages/activity/data';

/** The query param that opens catch up on Activity. */
export const CATCH_UP_PARAM = 'catchup';

/** The value that opens catch up from the newest unread (the Catch up bar). */
export const CATCH_UP_NEWEST = 'newest';

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
