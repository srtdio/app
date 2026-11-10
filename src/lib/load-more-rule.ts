import { useEffect, useState } from 'react';

// Load more only when there is more (decided 10 Nov 2026). One pure rule for
// every list that still ends with ui/LoadMore, applied per current chip or
// filter:
//
// 1. Fewer rows loaded for this filter than the current depth (one screen,
//    then +1 screen per Load more) and the server has more: fetch the next
//    server pages silently until depth is filled or the server is done. No
//    button while doing this.
// 2. Show Load more only when rows are loaded but not yet shown for this
//    filter, OR the server has more AND the rows shown equal the depth.
// 3. Never show Load more under a list that is shorter than its depth.
//
// A list whose server already filters (Activity, the pickers, chat info)
// passes depth = the rows it holds: nothing is held back, so the button is the
// server's "more" alone.

export interface LoadMoreInput {
  /** Rows loaded that match the current chip or filter. */
  matching: number;
  /** How many rows the list may show now: one screen, +1 screen per Load more. */
  depth: number;
  /** The server has another page (the last page came back full, or a total says so). */
  serverMore: boolean;
}

export interface LoadMoreDecision {
  /** Rows to show: the matching rows up to the depth. */
  shown: number;
  /** Rows loaded for this filter but held back by the depth. */
  hidden: number;
  /** Show the Load more button. */
  button: boolean;
  /** Read the next server page now, silently (no button, no busy). */
  fill: boolean;
}

/** The one Load more rule. Pure. */
export function loadMoreRule(input: LoadMoreInput): LoadMoreDecision {
  const matching = Math.max(0, input.matching);
  const depth = Math.max(0, input.depth);
  const shown = Math.min(matching, depth);
  const hidden = matching - shown;
  const fill = input.serverMore && matching < depth;
  const button = hidden > 0 || (input.serverMore && shown >= depth);
  return { shown, hidden, button, fill };
}

/**
 * The rule wired for a list that shows every loaded row of its filter (no
 * rows held back) and whose read is a parent's `onMore` (no success or
 * failure handed back). The depth is one `page`, +1 page per tap, reset when
 * `filterKey` changes. A short filter reads on silently, once per landed
 * page (`loaded`), so a failed read stops there and the button comes back as
 * the way to try again. A tap's read keeps the button (busy) until it lands.
 * Returns null when no button shows.
 */
export function useLoadMoreFill(input: {
  filterKey: string;
  matching: number;
  loaded: number;
  page: number;
  serverMore: boolean;
  busy: boolean;
  onMore: (() => void) | undefined;
}): { busy: boolean; onMore: () => void } | null {
  const { filterKey, matching, loaded, page, serverMore, busy, onMore } = input;
  const [depth, setDepth] = useState(page);
  const [depthFor, setDepthFor] = useState(filterKey);
  if (depthFor !== filterKey) {
    setDepthFor(filterKey);
    setDepth(page);
  }
  // Every loaded row of the filter shows, so none is held back.
  const rule = loadMoreRule({ matching, depth: Math.max(depth, matching), serverMore });
  // The loaded count the last silent read started from, and the last tap's.
  const [triedAt, setTriedAt] = useState<number | null>(null);
  const [pressedAt, setPressedAt] = useState<number | null>(null);
  const fill = rule.fill && triedAt !== loaded && onMore !== undefined;
  useEffect(() => {
    if (!fill || busy || onMore === undefined) return;
    setTriedAt(loaded);
    onMore();
  }, [fill, busy, onMore, loaded]);
  if (onMore === undefined) return null;
  const stalled = rule.fill && triedAt === loaded && !busy;
  const pressed = busy && pressedAt === loaded;
  if (!rule.button && !stalled && !pressed) return null;
  return {
    busy,
    onMore: () => {
      setDepth((d) => Math.max(d, matching) + page);
      setPressedAt(loaded);
      onMore();
    },
  };
}

/** Activity's list as laid out: item rows per section, in order, and its geometry. */
export interface RowsLayout {
  /** Item rows (after grouping) per section, in order. */
  sections: readonly number[];
  /** Laptop list columns (fillColumns); 1 on a phone. */
  columns: number;
  /** One row's height in the active density (60 / 72 / 80). */
  rowPx: number;
  /** A section heading with its step to the rows. */
  headingPx: number;
  /** Between sections. */
  gapPx: number;
}

/**
 * How many item rows, in order, fit in `heightPx` of list, and whether the
 * loaded rows reach it at all (when they do not, the list is shorter than its
 * depth). Rows sit `columns` to a line. Pure.
 */
export function rowsInHeight(
  layout: RowsLayout,
  heightPx: number,
): { rows: number; reached: boolean } {
  const columns = Math.max(1, Math.floor(layout.columns));
  let y = 0;
  let rows = 0;
  for (let i = 0; i < layout.sections.length; i += 1) {
    const n = layout.sections[i] ?? 0;
    if (n <= 0) continue;
    if (rows > 0) y += layout.gapPx;
    y += layout.headingPx;
    for (let left = n; left > 0; left -= columns) {
      if (y + layout.rowPx > heightPx) return { rows, reached: true };
      y += layout.rowPx;
      rows += Math.min(columns, left);
    }
  }
  return { rows, reached: false };
}

/** Activity's first depth: rows filling this many viewports from the list's top. */
export const ACTIVITY_FIRST_SCREENS = 1.45;

/**
 * Activity's Load more (10 Nov 2026): the depth is counted in ITEM ROWS after
 * grouping, never in inbox entries. The first depth is the rows that fill
 * 1.45 viewports from the list's top (headings, gaps, the density row,
 * laptop columns); each Load more adds one viewport. Pure.
 */
export function activityLoadMore(input: {
  layout: RowsLayout;
  /** The list's top in the page (px). */
  listTop: number;
  viewportH: number;
  /** Load more taps so far under this chip. */
  taps: number;
  serverMore: boolean;
}): LoadMoreDecision {
  const target =
    (ACTIVITY_FIRST_SCREENS + Math.max(0, input.taps)) * input.viewportH - input.listTop;
  const loaded = input.layout.sections.reduce((sum, n) => sum + Math.max(0, n), 0);
  const fit = rowsInHeight(input.layout, target);
  // Short of the depth: ask for one more row than is loaded (fill or stop).
  const depth = fit.reached ? fit.rows : loaded + 1;
  return loadMoreRule({ matching: loaded, depth, serverMore: input.serverMore });
}

/** The viewport as Activity's depth reads it (sync; 0 x 0 outside a browser). */
export function readViewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}
