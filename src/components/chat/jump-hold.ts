// The jump hold: after a search or card jump scrolls a row to the centre, rows
// above it can still change height (a shared post card resolving from its
// skeleton into its media frame, a preview landing). On iPhone WebKit that cuts
// the smooth scroll short and the row ends up outside the list, often just
// under the header where a window-based check still reads it as on screen. For
// a short hold after the jump the thread keeps the row centred: a size change
// that moves it re-centres at once (before paint), and the settle re-centres a
// row the scroll left outside the list. Pure, so it is tested without a DOM.

import type { ScrollSource } from '@/lib/chat/stick-to-bottom';

/** How long a jumped-to row stays held: the length of its tint. */
export const JUMP_HOLD_MS = 2000;

/** The vertical extent of a box on screen. */
interface VerticalBox {
  top: number;
  bottom: number;
}

/** The scrollTop change that puts the row's middle on the list's middle. */
export function centreDelta(list: VerticalBox, row: VerticalBox): number {
  return (row.top + row.bottom) / 2 - (list.top + list.bottom) / 2;
}

/** The row is wholly inside the list's visible box (not under a header or the composer). */
export function rowInsideList(list: VerticalBox, row: VerticalBox): boolean {
  return row.top >= list.top && row.bottom <= list.bottom;
}

/** Whether a held jump still holds: no reader gesture since, and inside its window. */
export function holdActive(input: { source: ScrollSource; now: number; until: number }): boolean {
  return input.source === 'program' && input.now <= input.until;
}

/**
 * What a held row needs after a layout change or at the settle. `moved` is
 * how far the row shifted in the list's content since the hold last looked
 * (a row above it changed height). A moved row re-centres; at the settle a
 * row outside the list re-centres too; anything else is left alone, so a
 * smooth scroll still running is never cut.
 */
export function recentreNeeded(input: {
  moved: number;
  settle: boolean;
  list: VerticalBox;
  row: VerticalBox;
}): boolean {
  if (Math.abs(input.moved) >= 1) return true;
  return input.settle && !rowInsideList(input.list, input.row);
}
