// The Excel viewer: the office Worker's plain cell strings as a table of React
// text nodes only (never library HTML, never dangerouslySetInnerHTML). Links
// are text, formulas show their saved value (or their text), hidden sheets are
// not listed. Sticky column letters and row numbers, merged cells as
// colSpan/rowSpan, widths from the sheet, numbers right-aligned in tabular
// mono. Both axes scroll inside the grid only; past ~200 rows only the rows
// near the viewport render. Sheet tabs sit at the bottom (44 px targets).
// Theme tokens throughout, so light and dark follow the app. Loaded lazily by
// FileViewer, never in the main chunk.

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { MutableRefObject, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { SheetCell, SheetMerge, SheetView, XlsxView } from '@/lib/files/office/types';

/** One grid row's height in px (h-7). */
export const ROW_HEIGHT = 28;
/** Row numbers column width in px. */
const ROW_HEAD_WIDTH = 48;
/** Above this many rows only a window near the viewport renders. */
export const VIRTUALIZE_AFTER = 200;
const OVERSCAN = 20;

/** Layout effect in the browser; a plain effect where there is no DOM (server render, tests). */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** "A".."Z", "AA".. Pure. */
export function columnLabel(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** "Calendar · 31 rows". Pure. */
export function sheetTitle(sheet: SheetView): string {
  return `${sheet.name} · ${fmt(sheet.totalRows)} ${sheet.totalRows === 1 ? 'row' : 'rows'}`;
}

/** The cap note, or null when everything is shown. Pure. */
export function capNote(sheet: SheetView): string | null {
  const parts: string[] = [];
  if (sheet.totalRows > sheet.shownRows) {
    parts.push(`Showing ${fmt(sheet.shownRows)} of ${fmt(sheet.totalRows)} rows.`);
  }
  if (sheet.totalCols > sheet.shownCols) {
    parts.push(`Showing ${fmt(sheet.shownCols)} of ${fmt(sheet.totalCols)} columns.`);
  }
  return parts.length > 0 ? `${parts.join(' ')} Download to see all.` : null;
}

/** The rows to render for a scroll position: all of them, or a window. Pure. */
export function rowWindow(
  scrollTop: number,
  viewportHeight: number,
  total: number,
): { start: number; end: number } {
  if (total <= VIRTUALIZE_AFTER) return { start: 0, end: total };
  const first = Math.floor(Math.max(scrollTop - ROW_HEIGHT, 0) / ROW_HEIGHT);
  const start = Math.max(first - OVERSCAN, 0);
  const end = Math.min(first + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN, total);
  return { start, end: Math.max(end, Math.min(start + 1, total)) };
}

interface Index {
  cells: Map<number, SheetCell>;
  merges: Map<number, SheetMerge>;
}

function indexSheet(sheet: SheetView): Index {
  const key = (r: number, c: number): number => r * sheet.shownCols + c;
  const cells = new Map<number, SheetCell>();
  for (const cell of sheet.cells) cells.set(key(cell.r, cell.c), cell);
  const merges = new Map<number, SheetMerge>();
  for (const m of sheet.merges) {
    for (let r = m.r0; r <= m.r1; r++) {
      for (let c = m.c0; c <= m.c1; c++) merges.set(key(r, c), m);
    }
  }
  return { cells, merges };
}

const CELL =
  'h-7 overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-border px-2 align-middle';
const HEAD =
  'border-b border-r border-border bg-panel-2 px-1 text-center text-[11px] font-medium text-fg-3';

/** The <td>s of one row; a merge renders once from its first row (or the window's first). */
function rowCells(
  sheet: SheetView,
  index: Index,
  r: number,
  start: number,
  end: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  const key = (row: number, c: number): number => row * sheet.shownCols + c;
  for (let c = 0; c < sheet.shownCols; c++) {
    const merge = index.merges.get(key(r, c));
    if (merge !== undefined) {
      if (c !== merge.c0 || (r !== merge.r0 && !(r === start && merge.r0 < start))) continue;
      const origin = index.cells.get(key(merge.r0, merge.c0));
      const colSpan = merge.c1 - merge.c0 + 1;
      const rowSpan = Math.min(merge.r1, end - 1) - r + 1;
      out.push(
        <td
          key={c}
          colSpan={colSpan > 1 ? colSpan : undefined}
          rowSpan={rowSpan > 1 ? rowSpan : undefined}
          data-merged=""
          className={cn(CELL, cellAlign(origin, colSpan > 1))}
        >
          {origin?.text ?? ''}
        </td>,
      );
      continue;
    }
    const cell = index.cells.get(key(r, c));
    out.push(
      <td key={c} className={cn(CELL, cellAlign(cell, false))}>
        {cell?.text ?? ''}
      </td>,
    );
  }
  return out;
}

function cellAlign(cell: SheetCell | undefined, centered: boolean): string | undefined {
  if (cell === undefined) return undefined;
  if (cell.kind === 'n') return 'text-right font-mono tabular-nums';
  if (cell.kind === 'b' || cell.kind === 'e' || centered) return 'text-center';
  return undefined;
}

function SheetGrid(props: {
  sheet: SheetView;
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
}): ReactElement {
  const { sheet, scrollerRef } = props;
  const index = useMemo(() => indexSheet(sheet), [sheet]);
  const [view, setView] = useState({ top: 0, height: 800 });

  useBrowserLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    setView({ top: 0, height: el.clientHeight || 800 });
  }, [sheet, scrollerRef]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null || sheet.shownRows <= VIRTUALIZE_AFTER) return;
    setView({ top: el.scrollTop, height: el.clientHeight });
  }, [scrollerRef, sheet.shownRows]);

  const { start, end } = rowWindow(view.top, view.height, sheet.shownRows);
  const width = ROW_HEAD_WIDTH + sheet.colWidths.reduce((a, b) => a + b, 0);
  const rows: ReactNode[] = [];
  for (let r = start; r < end; r++) {
    rows.push(
      <tr key={r} data-row={r + 1}>
        <th scope="row" className={cn(HEAD, 'sticky left-0 z-10 h-7 font-mono tabular-nums')}>
          {r + 1}
        </th>
        {rowCells(sheet, index, r, start, end)}
      </tr>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      data-sheet-scroller=""
      // Focusable so arrows and Page Down scroll the grid on Safari.
      tabIndex={0}
      aria-label={sheet.name}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-auto overscroll-contain bg-panel [touch-action:pan-x_pan-y] focus-visible:outline-none"
    >
      <table
        data-sheet-grid=""
        className="border-separate border-spacing-0 text-xs text-fg [table-layout:fixed]"
        style={{ width: `${width}px` }}
      >
        <colgroup>
          <col style={{ width: `${ROW_HEAD_WIDTH}px` }} />
          {sheet.colWidths.map((w, c) => (
            <col key={c} style={{ width: `${w}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th aria-hidden="true" className={cn(HEAD, 'sticky left-0 top-0 z-30 h-7')} />
            {sheet.colWidths.map((_, c) => (
              <th key={c} scope="col" className={cn(HEAD, 'sticky top-0 z-20 h-7')}>
                {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 ? (
            <tr aria-hidden="true" style={{ height: `${start * ROW_HEIGHT}px` }}>
              <td colSpan={sheet.shownCols + 1} />
            </tr>
          ) : null}
          {rows}
          {end < sheet.shownRows ? (
            <tr aria-hidden="true" style={{ height: `${(sheet.shownRows - end) * ROW_HEIGHT}px` }}>
              <td colSpan={sheet.shownCols + 1} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function SheetViewer(props: {
  book: XlsxView;
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
}): ReactElement {
  const { book, scrollerRef } = props;
  const [active, setActive] = useState(0);
  const sheet = book.sheets[Math.min(active, book.sheets.length - 1)] ?? book.sheets[0];
  if (sheet === undefined) return <div />;
  const note = capNote(sheet);
  return (
    <div
      data-sheet-viewer=""
      className="absolute inset-0 flex flex-col overflow-hidden bg-panel text-fg"
    >
      <p
        data-sheet-title=""
        className="shrink-0 truncate border-b border-border px-4 py-2 font-mono text-xs text-fg-2"
      >
        {sheetTitle(sheet)}
      </p>
      <SheetGrid sheet={sheet} scrollerRef={scrollerRef} />
      {note !== null ? (
        <p
          data-sheet-cap=""
          className="shrink-0 border-t border-border px-3 py-2 text-xs leading-snug text-fg-2"
        >
          {note}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label="Sheets"
        className="flex shrink-0 gap-1 overflow-x-auto overscroll-contain border-t border-border bg-panel px-2 pb-[max(env(safe-area-inset-bottom),4px)] pt-1"
      >
        {book.sheets.map((s, i) => {
          const selected = s === sheet;
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={selected}
              data-sheet-tab={s.name}
              onClick={() => setActive(i)}
              className={cn(
                'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                selected ? 'bg-panel-2 font-medium text-fg' : 'text-fg-2 hover:bg-panel-2',
              )}
            >
              {s.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
