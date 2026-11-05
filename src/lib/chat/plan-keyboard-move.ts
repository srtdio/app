// Pure Plan move rules shared by the Plan screen, the item screen and the
// Plan tab: the day-change toast and the slot count of a day. No React, no reads.

import type { DayIds } from '@/lib/chat/plan-drag';

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

/** How many rows of `day` there are without `itemId` (the slots are 0..that). Pure. */
export function othersIn(days: readonly DayIds[], itemId: string, day: string | null): number {
  const group = days.find((d) => d.day === day);
  return group === undefined ? 0 : group.ids.filter((id) => id !== itemId).length;
}
