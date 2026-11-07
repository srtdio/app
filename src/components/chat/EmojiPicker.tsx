// The full emoji picker's body behind the reactions row's "+": a row of group
// tabs that stays put (no search field; a tab jumps to its group), and the grid grouped by Unicode group below it. Glyphs render as text in the
// app's emoji font stack (no images, no emoji library); the data is generated
// once from Unicode 15.0 (emoji-data.ts). This module and its data load through
// a dynamic import() (MessageActionMenu starts it when the menu opens), so
// neither is in the main chunk; the sheet / popover shell, its focus trap and
// its close rules live in MessageActionMenu. The grid is virtualized: fixed
// 44px rows, only the visible rows plus a 3-row buffer are rendered, and a
// group tab jumps by row index. Every control is at least 44x44. Tokens only,
// so light and dark stay at parity.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, ReactElement, ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { EMOJI, EMOJI_GROUPS, type EmojiEntry } from '@/components/chat/emoji-data';
import { EMOJI_GLYPH_TYPE, EMOJI_GROUP_TYPE, type ChatLayout } from '@/components/chat/chat-type';

/** Every grid row (a group heading or a line of glyphs) is this tall. */
export const EMOJI_ROW_PX = 44;

/** Rows rendered past each edge of the visible window. */
export const EMOJI_ROW_BUFFER = 3;

/** One group of the grid. */
export interface EmojiSection {
  group: string;
  emojis: readonly EmojiEntry[];
}

/** The grid's sections, one per Unicode group, in Unicode order. Pure. */
export function emojiSections(list: readonly EmojiEntry[] = EMOJI): EmojiSection[] {
  return EMOJI_GROUPS.map((group) => ({
    group,
    emojis: list.filter((entry) => entry.group === group),
  })).filter((section) => section.emojis.length > 0);
}

/** A group's tab glyph: its first emoji. */
export function groupTabGlyph(section: EmojiSection): string {
  return section.emojis[0]?.char ?? '';
}

const SECTIONS = emojiSections();

/** One fixed-height row of the virtual grid. */
export type EmojiRow =
  | { kind: 'heading'; group: string }
  | { kind: 'glyphs'; emojis: readonly EmojiEntry[] };

/** The grid as rows: a heading then its glyph lines per section. Pure. */
export function emojiRows(sections: readonly EmojiSection[], columns: number): EmojiRow[] {
  const perRow = Math.max(1, Math.floor(columns));
  const rows: EmojiRow[] = [];
  for (const section of sections) {
    rows.push({ kind: 'heading', group: section.group });
    for (let i = 0; i < section.emojis.length; i += perRow) {
      rows.push({ kind: 'glyphs', emojis: section.emojis.slice(i, i + perRow) });
    }
  }
  return rows;
}

/** The row index each group's heading sits at: where its tab jumps. Pure. */
export function groupRowIndex(rows: readonly EmojiRow[]): Map<string, number> {
  const index = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.kind === 'heading') index.set(row.group, i);
  });
  return index;
}

/** The group whose heading is at or above the top of the window. Pure. */
export function groupAtRow(rows: readonly EmojiRow[], topRow: number): string | null {
  let current: string | null = null;
  for (let i = 0; i < rows.length && i <= topRow; i += 1) {
    const row = rows[i];
    if (row?.kind === 'heading') current = row.group;
  }
  return current;
}

/**
 * The rows to render for a scroll position: the visible ones plus a
 * EMOJI_ROW_BUFFER-row buffer each way, as [start, end). Pure.
 */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
): { start: number; end: number } {
  const first = Math.floor(Math.max(0, scrollTop) / EMOJI_ROW_PX);
  const visible = Math.ceil(Math.max(0, viewportHeight) / EMOJI_ROW_PX) + 1;
  const start = Math.max(0, first - EMOJI_ROW_BUFFER);
  const end = Math.min(rowCount, first + visible + EMOJI_ROW_BUFFER);
  return { start, end: Math.max(start, end) };
}

/**
 * The row indices to render: the visible range plus the row holding focus when
 * it scrolled out, so the focused glyph stays mounted and focus never drops to
 * the body. Ascending. Pure.
 */
export function renderedRowIndices(
  range: { start: number; end: number },
  keepRow: number | null,
  rowCount: number,
): number[] {
  const out: number[] = [];
  for (let i = range.start; i < range.end; i += 1) out.push(i);
  if (keepRow === null || keepRow < 0 || keepRow >= rowCount) return out;
  if (keepRow < range.start) return [keepRow, ...out];
  if (keepRow >= range.end) return [...out, keepRow];
  return out;
}

/** Where a group tab scrolls the grid: its heading row. Pure. */
export function tabJumpTop(group: string, headingRow: ReadonlyMap<string, number>): number {
  return (headingRow.get(group) ?? 0) * EMOJI_ROW_PX;
}

/**
 * The highlighted tab after a scroll: unchanged for the scroll a tab jump
 * itself caused (the tapped group stays highlighted
 * even where the end of the list clamps the jump); else the group at the top
 * of the window. Pure.
 */
export function activeGroupAfterScroll(params: {
  rows: readonly EmojiRow[];
  scrollTop: number;
  jumpTop: number | null;
  current: string | null;
}): string | null {
  if (params.jumpTop === params.scrollTop) return params.current;
  return groupAtRow(params.rows, Math.floor(params.scrollTop / EMOJI_ROW_PX)) ?? params.current;
}

/** Glyph columns that fit a grid this wide (44px each, 4px side padding). Pure. */
export function gridColumns(width: number): number {
  return Math.max(1, Math.floor((width - 8) / EMOJI_ROW_PX));
}

/** One 44x44 glyph button. */
function EmojiButton(props: { entry: EmojiEntry; onPick: (char: string) => void }): ReactElement {
  return (
    <IconButton
      type="button"
      data-emoji={props.entry.char}
      label={props.entry.name}
      title={props.entry.name}
      onClick={() => props.onPick(props.entry.char)}
      className={cn('shrink-0', EMOJI_GLYPH_TYPE)}
    >
      <span aria-hidden="true">{props.entry.char}</span>
    </IconButton>
  );
}

/** The picker's top row: `trailing` (the shell's close control) at the end. */
export function EmojiPickerTop(props: { trailing?: ReactNode }): ReactElement {
  return (
    <div data-emoji-top="" className="flex shrink-0 items-center justify-end gap-1 px-2 pt-2">
      {props.trailing}
    </div>
  );
}

/** The group tab row: one 44x44 tab per Unicode group; it sits outside the scroll. */
export function EmojiTabs(props: {
  activeGroup: string | null;
  onTab: (group: string) => void;
}): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="Emoji groups"
      data-emoji-tabs=""
      className="flex shrink-0 justify-between overflow-x-auto border-b border-border px-1 lit-well"
    >
      {SECTIONS.map((section) => (
        <IconButton
          key={section.group}
          type="button"
          role="tab"
          label={section.group}
          aria-selected={props.activeGroup === section.group}
          data-emoji-tab={section.group}
          data-selected={props.activeGroup === section.group ? 'true' : undefined}
          onClick={() => props.onTab(section.group)}
          className={cn(
            'shrink-0 text-fg-3',
            props.activeGroup === section.group && 'bg-accent text-accent-fg lit-pill',
            EMOJI_GLYPH_TYPE,
          )}
        >
          <span aria-hidden="true">{groupTabGlyph(section)}</span>
        </IconButton>
      ))}
    </div>
  );
}

/**
 * The virtual grid: a spacer as tall as every row, with only the rows in
 * visibleRowRange rendered at their offsets. Hook-free.
 */
export function EmojiVirtualGrid(props: {
  rows: readonly EmojiRow[];
  scrollTop: number;
  viewportHeight: number;
  onPick: (char: string) => void;
  /** The row holding focus: kept mounted when it scrolls out of the window. */
  keepRow?: number | null;
}): ReactElement {
  const range = visibleRowRange(props.scrollTop, props.viewportHeight, props.rows.length);
  const indices = renderedRowIndices(range, props.keepRow ?? null, props.rows.length);
  return (
    <div
      data-emoji-rows={props.rows.length}
      className="relative"
      style={{ height: props.rows.length * EMOJI_ROW_PX }}
    >
      {indices.map((index) => {
        const row = props.rows[index];
        if (row === undefined) return null;
        const top = index * EMOJI_ROW_PX;
        if (row.kind === 'heading') {
          return (
            <h3
              key={`h-${row.group}`}
              data-emoji-row={index}
              data-emoji-section={row.group}
              className={cn(
                'absolute inset-x-0 flex h-11 items-end px-3 pb-1 text-fg-3',
                EMOJI_GROUP_TYPE,
              )}
              style={{ top }}
            >
              {row.group}
            </h3>
          );
        }
        return (
          <div
            key={`r-${index}`}
            data-emoji-row={index}
            className="absolute inset-x-0 flex h-11 justify-start px-1"
            style={{ top }}
          >
            {row.emojis.map((entry) => (
              <EmojiButton key={entry.char} entry={entry} onPick={props.onPick} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The picker's contents inside the shell: the top row (with `trailing`, the
 * shell's close control), the group tabs, then the scrolling virtual grid.
 * Owns the active tab and the scroll window.
 */
export function EmojiPickerPanel(props: {
  onPick: (char: string) => void;
  /** The shell passes its layout; the body has no layout-sized part since the search field went. */
  layout: ChatLayout;
  trailing?: ReactNode;
}): ReactElement {
  const [activeGroup, setActiveGroup] = useState<string | null>(SECTIONS[0]?.group ?? null);
  const [view, setView] = useState({ scrollTop: 0, height: 0, width: 0 });
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scrollTop a tab jump set; its own scroll event keeps the tapped tab.
  const jumpTopRef = useRef<number | null>(null);
  const columns = gridColumns(view.width);
  // Rows change only with the width, never on a scroll render.
  const rows = useMemo(() => emojiRows(SECTIONS, columns), [columns]);
  const headingRow = useMemo(() => groupRowIndex(rows), [rows]);

  // The window's size, before paint and on every resize of the grid.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void =>
      setView((v) =>
        v.height === el.clientHeight && v.width === el.clientWidth
          ? v
          : { ...v, height: el.clientHeight, width: el.clientWidth },
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollTo = (top: number): void => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = top;
    const actual = el?.scrollTop ?? top;
    jumpTopRef.current = actual;
    setView((v) => (v.scrollTop === actual ? v : { ...v, scrollTop: actual }));
  };

  const onTab = (group: string): void => {
    setActiveGroup(group);
    scrollTo(tabJumpTop(group, headingRow));
  };
  // The tab follows the group at the top of the window.
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const scrollTop = el.scrollTop;
    setView((v) => (v.scrollTop === scrollTop ? v : { ...v, scrollTop }));
    const next = activeGroupAfterScroll({
      rows,
      scrollTop,
      jumpTop: jumpTopRef.current,
      current: activeGroup,
    });
    if (jumpTopRef.current !== scrollTop) jumpTopRef.current = null;
    if (next !== activeGroup) setActiveGroup(next);
  };
  // The row holding focus stays mounted while it is scrolled out of the window.
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const row = (event.target as Element).closest('[data-emoji-row]');
    const index = row === null ? NaN : Number(row.getAttribute('data-emoji-row'));
    setFocusRow(Number.isNaN(index) ? null : index);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusRow(null);
  };

  return (
    <>
      <EmojiPickerTop trailing={props.trailing} />
      <EmojiTabs activeGroup={activeGroup} onTab={onTab} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onFocus={onFocus}
        onBlur={onBlur}
        data-emoji-scroll=""
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        <EmojiVirtualGrid
          rows={rows}
          onPick={props.onPick}
          scrollTop={view.scrollTop}
          viewportHeight={view.height}
          keepRow={focusRow}
        />
      </div>
    </>
  );
}
