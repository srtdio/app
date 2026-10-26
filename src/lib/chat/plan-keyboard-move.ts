// Pure rules behind the Plan list's keyboard move (laptop, agency): Space
// picks a row up, Up/Down steps it through every slot of every droppable day
// (within a day first, then into the next or previous day), Space or Enter
// drops it (one plan_item_move), Escape puts it back. Also the key map, the
// live-region lines and the day-change toast. No React, no reads.

import { findItem, moveItem, type DayIds, type DayIndex } from '@/lib/chat/plan-drag';
import type { PlanWeekGroup } from '@/lib/plan-week';

export const PICKED_UP = 'Picked up';
export const DROPPED = 'Dropped';
export const MOVE_CANCELLED = 'Move cancelled';
export const REMOVE_LABEL = 'Remove from plan';
export const CHANGE_DAY_LABEL = 'Change day';
export const MOVE_TO_HEADING = 'Move to';
export const GRIP_LABEL = 'Drag to move';
export const DROP_HERE = 'Drop here';
/** The slim footer line under the laptop list (agency only). */
export const KEY_HINTS =
  'Drag handle to move · Space pick up, arrows move, Space drop · Del remove';

/**
 * The toast after an item changes day, phone and laptop alike: "Moved to Wed
 * 14 Oct." (a post adds " Due date updated."), and when the move reset
 * its ticks " Its ticks were reset." with no Undo (the agency cannot put a
 * client's tick back); a move that reset nothing offers Undo. Pure.
 */
export function dayMoveToast(
  dayHeader: string | null,
  post: boolean,
  ticksReset: boolean,
): { title: string; undo: boolean } {
  const moved = `Moved to ${dayHeader ?? 'No date'}.${post ? ' Due date updated.' : ''}`;
  return ticksReset
    ? { title: `${moved} Its ticks were reset.`, undo: false }
    : { title: moved, undo: true };
}

/** The live-region line for a slot: "Wed 14 Oct, position 2". Pure. */
export function slotAnnouncement(dayLabel: string, index: number): string {
  return `${dayLabel}, position ${index + 1}`;
}

/** How many rows of `day` there are without `itemId` (the slots are 0..that). Pure. */
export function othersIn(days: readonly DayIds[], itemId: string, day: string | null): number {
  const group = days.find((d) => d.day === day);
  return group === undefined ? 0 : group.ids.filter((id) => id !== itemId).length;
}

/**
 * The next slot from `at` one step in `dir`: down a day's slots, then the
 * first slot of the next droppable day; up, then the last slot of the
 * previous one. Null at either end or when `at` is not a droppable day. Pure.
 */
export function stepSlot(
  days: readonly DayIds[],
  itemId: string,
  at: DayIndex,
  dir: 1 | -1,
  droppable: (day: string | null) => boolean,
): DayIndex | null {
  const order = days.filter((d) => droppable(d.day));
  const k = order.findIndex((d) => d.day === at.day);
  if (k < 0) return null;
  const last = othersIn(days, itemId, at.day);
  if (dir === 1 && at.index < last) return { day: at.day, index: at.index + 1 };
  if (dir === -1 && at.index > 0) return { day: at.day, index: at.index - 1 };
  const next = order[k + dir];
  if (next === undefined) return null;
  return { day: next.day, index: dir === 1 ? 0 : othersIn(days, itemId, next.day) };
}

/**
 * The list's groups with `itemId` shown at `to` (a pick-up's preview; nothing
 * is written until the drop). The same groups when the item is in none. Pure.
 */
export function previewGroups<T extends { id: string }>(
  groups: readonly PlanWeekGroup<T>[],
  itemId: string,
  to: DayIndex,
): PlanWeekGroup<T>[] {
  const all = groups.flatMap((w) => w.days.flatMap((d) => d.items));
  const moved = all.find((i) => i.id === itemId);
  if (moved === undefined) return [...groups];
  const days = groups.flatMap((w) =>
    w.days.map((d) => ({ day: d.day, ids: d.items.map((i) => i.id) })),
  );
  if (findItem(days, itemId) === null) return [...groups];
  const next = moveItem(days, itemId, to.day, to.index);
  const byId = new Map(all.map((i) => [i.id, i]));
  let at = 0;
  return groups.map((w) => ({
    ...w,
    days: w.days.map((d) => {
      const ids = next[at]?.ids ?? [];
      at += 1;
      return { ...d, items: ids.flatMap((id) => byId.get(id) ?? []) };
    }),
  }));
}

/** What a key does on a focused agency row (laptop). Pure. */
type RowKeyIntent = 'pick' | 'drop' | 'cancel' | 'up' | 'down' | 'remove' | null;

export function rowKeyIntent(key: string, picking: boolean): RowKeyIntent {
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (picking) {
    if (key === ' ' || key === 'Enter') return 'drop';
    if (key === 'Escape') return 'cancel';
    return null;
  }
  if (key === ' ') return 'pick';
  if (key === 'Delete' || key === 'Backspace') return 'remove';
  return null;
}
