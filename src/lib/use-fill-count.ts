// Fill the first screen, then load more (decided 7 Nov 2026). Every list shows
// as many rows as the first screen holds, on every device, then "Show N more" /
// Load more adds the same count again. No device is hard-coded: the number
// comes from the screen the app runs on, read ONCE per app load (no resize or
// scroll listener, no element measuring, no await) and reused by every list.

import { listCardHeightPx } from '@/components/ui/ListCard';

/** The fewest rows a first page shows (the old fixed cap). */
export const FILL_COUNT_FLOOR = 6;
/** The most rows a first page shows, however tall the screen. */
export const FILL_COUNT_CEILING = 40;

/** md: the laptop layout starts here (Tailwind's md, 768px). */
const MD_PX = 768;
/** The laptop Sidebar's width (shell/Sidebar, w-60). */
const SIDEBAR_PX = 240;
/** The laptop page gutters, both sides (ui/layout GUTTER md:px-6). */
const LAPTOP_GUTTERS_PX = 48;
/** One laptop list column's minimum width (tailwind grid-cols-list-cards). */
const LIST_COLUMN_PX = 360;

/**
 * Rows the first page shows: one row more than the screen height holds (so the
 * list always runs past the fold), times the laptop columns, kept in 6..40.
 * rowPx is the active density's row height (60 / 72 / 80). Pure.
 */
export function fillCount(viewportH: number, columns = 1, rowPx = listCardHeightPx()): number {
  const rows = Math.ceil(viewportH / rowPx) + 1;
  const count = rows * Math.max(1, Math.floor(columns));
  if (!Number.isFinite(count)) return FILL_COUNT_FLOOR;
  return Math.min(FILL_COUNT_CEILING, Math.max(FILL_COUNT_FLOOR, count));
}

/**
 * The laptop list columns for a window width: below md one column; from md the
 * width left after the Sidebar and the gutters, in 360 columns. Pure.
 */
export function fillColumns(viewportW: number): number {
  if (viewportW < MD_PX) return 1;
  return Math.max(1, Math.floor((viewportW - SIDEBAR_PX - LAPTOP_GUTTERS_PX) / LIST_COLUMN_PX));
}

let stored: number | null = null;
/** The density the stored count was computed for. */
let storedFor: string | undefined;

/** The density on <html> (src/lib/density.ts sets it at boot), read sync. */
function htmlDensity(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement.dataset.density;
}

/**
 * The one fill count for this app load: computed on first use from the
 * window's size and the active density's row height, then reused. Outside a browser it is the floor and nothing is
 * stored, so the first browser call still reads the real screen.
 */
export function getFillCount(): number {
  // Density changed mid-session (account menu): read the count once again.
  if (stored !== null && storedFor === htmlDensity()) return stored;
  if (typeof window === 'undefined') return FILL_COUNT_FLOOR;
  storedFor = htmlDensity();
  stored = fillCount(window.innerHeight, fillColumns(window.innerWidth), listCardHeightPx(storedFor));
  return stored;
}

/** The fill count for this app load (one stored value; no listener, no state). */
export function useFillCount(): number {
  return getFillCount();
}

/** Tests only: forget the stored value so the next call reads the window again. */
export function resetFillCountForTest(): void {
  stored = null;
  storedFor = undefined;
}
