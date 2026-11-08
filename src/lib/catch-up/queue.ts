// Catch up's queue (Slack's way): one card per notification (an inbox entry,
// never a group). The tapped entry first (read or unread), then every other
// UNREAD entry of the workspace the Activity screen already holds, newest
// first, snoozed ones left out. The queue is fixed when catch up opens: new
// arrivals wait for the next time. Pure.

import { isSnoozed, type ActivityItem } from '@/components/pages/activity/data';

function newestFirst(a: ActivityItem, b: ActivityItem): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The fixed queue: `tapped` first, then `follow` (a group head's other
 * entries, unread only, newest first), then every other unread, not snoozed
 * entry of the tapped entry's workspace from `held`, newest first. Distinct by
 * id. With no tapped entry (the Catch up bar) the queue is the unread entries
 * newest first. Pure.
 */
export function buildCatchUpQueue(input: {
  tapped: ActivityItem | null;
  held: readonly ActivityItem[];
  nowMs: number;
  follow?: readonly ActivityItem[];
  workspaceId?: string | null;
}): ActivityItem[] {
  const { tapped, held, nowMs } = input;
  const workspaceId = tapped?.workspaceId ?? input.workspaceId ?? null;
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  const take = (item: ActivityItem): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };
  if (tapped !== null) take(tapped);
  const waiting = (item: ActivityItem): boolean =>
    item.readAt === null &&
    !isSnoozed(item, nowMs) &&
    (workspaceId === null || item.workspaceId === workspaceId);
  [...(input.follow ?? [])].filter(waiting).sort(newestFirst).forEach(take);
  [...held].filter(waiting).sort(newestFirst).forEach(take);
  return out;
}

/** The entry a group head opens first: its newest. Pure. */
export function groupHeadEntry(group: readonly ActivityItem[]): ActivityItem | undefined {
  return [...group].sort(newestFirst)[0];
}

/** Every distinct entry the screen holds, from any number of lists, first copy wins. Pure. */
export function heldEntries(...lists: ReadonlyArray<readonly ActivityItem[] | undefined>): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
