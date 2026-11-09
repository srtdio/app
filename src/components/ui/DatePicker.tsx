// A custom in-app calendar control. A native <input type="date"> overflows the
// sheet, so this matches the Select look (h-11 trigger, calendar icon, the
// selected date left-aligned or a placeholder) and opens a small month-grid
// popover (prev/next month, day cells, a today marker, the selected day on
// accent). Controlled by an ISO yyyy-mm-dd string (empty = no selection). The
// date math and the day cells are pure helpers so they unit-test without a DOM.
// The popover renders in a layer on the body, placed from the trigger's live
// rect, so a sheet's scroll area never clips it: below the trigger when there is
// room, above it otherwise.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { centreOf, menuMoves } from '@/components/ui/popover-classes';
import { useDismissLayer, useModalScopeNode } from '@/lib/modal-focus';
import { formatSpokenDate } from '@/lib/time';
import { usePresence } from '@/lib/motion';
import { viewportSize } from '@/lib/use-is-laptop';
import { Button, ClearButton } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconCalendar, IconChevronLeft, IconChevronRight, ICON_SIZE } from '@/components/ui/icons';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Compose an ISO yyyy-mm-dd string from a 0-based month index. */
export function toISO(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

/** Parse an ISO yyyy-mm-dd string to a 0-based month index, or null when malformed. */
export function parseISO(value: string): { year: number; monthIndex: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  return { year, monthIndex, day };
}

/** Move a (year, 0-based month) pair by delta months, carrying across years. */
export function shiftMonth(
  year: number,
  monthIndex: number,
  delta: number,
): { year: number; monthIndex: number } {
  const total = year * 12 + monthIndex + delta;
  return { year: Math.floor(total / 12), monthIndex: ((total % 12) + 12) % 12 };
}

/**
 * Leading-null-padded day cells for a month grid: nulls for the weekday offset
 * of the 1st, then 1..daysInMonth. Pure so the grid shape is unit-tested.
 */
export function monthGrid(year: number, monthIndex: number): (number | null)[] {
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  return cells;
}

/** Human-readable label for the trigger (e.g. "June 16, 2026"). */
export function formatDisplay(value: string): string {
  const parsed = parseISO(value);
  if (parsed === null) return value;
  return `${MONTHS[parsed.monthIndex]} ${parsed.day}, ${parsed.year}`;
}

/**
 * Move an ISO day by `days` (calendar arithmetic, no zone involved). Pure so the
 * grid's arrow keys unit-test without a DOM.
 */
export function shiftDay(iso: string, days: number): string {
  const parsed = parseISO(iso);
  if (parsed === null) return iso;
  const d = new Date(Date.UTC(parsed.year, parsed.monthIndex, parsed.day + days));
  return toISO(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Days each arrow key moves in the grid (Home/End: to the week's ends). */
export function gridKeyTarget(iso: string, key: string): string | null {
  const parsed = parseISO(iso);
  if (parsed === null) return null;
  const weekday = new Date(Date.UTC(parsed.year, parsed.monthIndex, parsed.day)).getUTCDay();
  switch (key) {
    case 'ArrowLeft':
      return shiftDay(iso, -1);
    case 'ArrowRight':
      return shiftDay(iso, 1);
    case 'ArrowUp':
      return shiftDay(iso, -7);
    case 'ArrowDown':
      return shiftDay(iso, 7);
    case 'Home':
      return shiftDay(iso, -weekday);
    case 'End':
      return shiftDay(iso, 6 - weekday);
    default:
      return null;
  }
}

/**
 * The day that holds the grid's one tab stop for a shown month: `focusISO`
 * when it is in that month, else the selected day, else today, else the 1st;
 * never a day before `minISO` when another day in the month can take it.
 */
export function rovingDay(
  year: number,
  monthIndex: number,
  focusISO: string,
  selectedISO: string,
  todayISO: string,
  minISO?: string,
): string {
  const prefix = `${year}-${pad(monthIndex + 1)}-`;
  const min = minISO ?? '';
  const ok = (iso: string): boolean => iso.startsWith(prefix) && (min === '' || iso >= min);
  for (const candidate of [focusISO, selectedISO, todayISO]) {
    if (ok(candidate)) return candidate;
  }
  const first = toISO(year, monthIndex, 1);
  if (min !== '' && min.startsWith(prefix) && min > first) return min;
  return first;
}

/** Split day cells into week rows of seven (role=row in the grid). */
export function weekRows<T>(cells: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

/**
 * Day cell buttons for the calendar grid: 44x44 touch targets. The selected day
 * uses the accent fill; today (when not selected) carries an accent ring. Days
 * before minISO (when given) are greyed and cannot be picked. Each day's name is
 * its spoken date (formatSpokenDate, e.g. "Saturday, 14 November 2026"); only
 * `tabISO` takes Tab (a roving stop, the arrows move it). Pure (no hooks) so
 * picking a day and the markers are unit-testable.
 */
export function dayCells(
  year: number,
  monthIndex: number,
  selectedISO: string,
  todayISO: string,
  onPick: (iso: string) => void,
  minISO?: string,
  tabISO?: string,
): ReactElement[] {
  return monthGrid(year, monthIndex).map((day, index) => {
    if (day === null) return <span key={`blank-${index}`} role="presentation" aria-hidden="true" />;
    const iso = toISO(year, monthIndex, day);
    const selected = iso === selectedISO;
    const isToday = iso === todayISO;
    const past = minISO !== undefined && minISO !== '' && iso < minISO;
    return (
      <button
        key={iso}
        type="button"
        role="gridcell"
        aria-selected={selected}
        aria-label={formatSpokenDate(iso)}
        {...(isToday ? { 'aria-current': 'date' as const } : {})}
        data-iso={iso}
        tabIndex={tabISO === undefined || iso === tabISO ? 0 : -1}
        disabled={past}
        aria-disabled={past ? 'true' : undefined}
        onClick={() => {
          if (!past) onPick(iso);
        }}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-lg text-base tabular-nums mv-tint focus-visible:lit-focus',
          // Past days are solid fg-3 ink, never a fade.
          past
            ? 'cursor-default text-fg-3'
            : selected
              ? 'bg-accent text-accent-fg lit-pill'
              : 'lit-hover text-fg',
          !selected && !past && isToday ? 'lit-today' : '',
        )}
      >
        {day}
      </button>
    );
  });
}

interface DatePickerProps {
  /** ISO yyyy-mm-dd string, or '' for no selection. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible label for the trigger. */
  label?: string;
  /** Days before today are greyed and cannot be picked. */
  disablePast?: boolean;
  /**
   * Optional: days before this ISO yyyy-mm-dd day are greyed and cannot be
   * picked (e.g. tomorrow for Book a call). Wins over disablePast when set.
   */
  min?: string;
  /** Show the "Clear date" and "Done" buttons under the grid. */
  actions?: boolean;
  /** The trigger's id (a Field label points at it). */
  id?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Select a date',
  label,
  disablePast = false,
  min,
  actions = false,
  id,
}: DatePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const initial = parseISO(value);
  const [view, setView] = useState<{ year: number; monthIndex: number }>(
    () => initial ?? { year: now.getFullYear(), monthIndex: now.getMonth() },
  );
  const todayISO = toISO(now.getFullYear(), now.getMonth(), now.getDate());

  // Snap the visible month to the selected date each time the popover opens, so
  // reopening after a pick lands on the chosen month rather than a stale one.
  useEffect(() => {
    if (!open) return;
    const parsed = parseISO(value);
    if (parsed !== null) setView({ year: parsed.year, monthIndex: parsed.monthIndex });
  }, [open, value]);

  // Escape closes only this popover while it is the top layer, never the sheet
  // under it; every close hands focus back to the trigger.
  // The calendar grows from the trigger and shrinks back to it (growFromTrigger).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const presence = usePresence<HTMLDivElement>(
    open,
    menuMoves(() => centreOf(triggerRef.current)),
  );
  const panelRef = presence.ref;
  useDismissLayer(open, () => setOpen(false), panelRef);
  // Portaled onto <body>: inside a Sheet, the Sheet's Tab trap lets focus live here.
  useModalScopeNode(panelRef, open);

  // The grid's one tab stop. Open: focus moves onto it (the selected day, else
  // today); the arrows move it and cross into the next or previous month.
  const minISO =
    min !== undefined && parseISO(min) !== null ? min : disablePast ? todayISO : undefined;
  const [focusISO, setFocusISO] = useState('');
  const tabISO = rovingDay(view.year, view.monthIndex, focusISO, value, todayISO, minISO);
  useEffect(() => {
    if (!open) {
      setFocusISO('');
      return;
    }
    const parsed = parseISO(value);
    setFocusISO(parsed !== null ? value : todayISO);
    // Only on open: the arrows own focus after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open || focusISO === '') return;
    const cell = panelRef.current?.querySelector<HTMLElement>(`[data-iso="${tabISO}"]`);
    cell?.focus({ preventScroll: true });
    // Focus follows the roving day only when it changes (open, an arrow key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusISO]);

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const target = gridKeyTarget(tabISO, event.key);
    if (target === null) return;
    event.preventDefault();
    if (minISO !== undefined && target < minISO) return;
    const parsed = parseISO(target);
    if (parsed === null) return;
    if (parsed.year !== view.year || parsed.monthIndex !== view.monthIndex) {
      setView({ year: parsed.year, monthIndex: parsed.monthIndex });
    }
    setFocusISO(target);
  }

  function pick(iso: string): void {
    onChange(iso);
    setOpen(false);
  }

  // Re-place the open popover when the page scrolls or resizes under it.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const bump = (): void => setTick((t) => t + 1);
    window.addEventListener('resize', bump);
    document.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('resize', bump);
      document.removeEventListener('scroll', bump, true);
    };
  }, [open]);

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        {...(id !== undefined ? { id } : {})}
        {...(label !== undefined ? { 'aria-label': label } : {})}
        onClick={() => setOpen((prev) => !prev)}
        className="lit-well lit-hover flex h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-field bg-panel-2 px-3 text-base mv-tint focus-visible:lit-focus"
      >
        <IconCalendar size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            value !== '' ? 'text-fg' : 'text-fg-3',
          )}
        >
          {value !== '' ? formatDisplay(value) : placeholder}
        </span>
      </button>

      {presence.rendered && triggerRef.current !== null
        ? createPortal(
            <>
              {open ? (
                <div
                  className="fixed inset-0 z-picker-catch"
                  aria-hidden="true"
                  onClick={() => setOpen(false)}
                />
              ) : null}
              <div
                ref={panelRef}
                role="dialog"
                aria-label="Choose a date"
                className="lit-overlay fixed z-picker rounded-xl border bg-panel p-2"
                style={popoverPlacement(triggerRef.current.getBoundingClientRect(), viewportSize())}
              >
                <div className="mb-1 flex items-center justify-between">
                  <IconButton
                    label="Previous month"
                    onClick={() => setView((v) => shiftMonth(v.year, v.monthIndex, -1))}
                  >
                    <IconChevronLeft size={ICON_SIZE.control} />
                  </IconButton>
                  <span className="text-base font-medium text-fg">
                    {MONTHS[view.monthIndex]} {view.year}
                  </span>
                  <IconButton
                    label="Next month"
                    onClick={() => setView((v) => shiftMonth(v.year, v.monthIndex, 1))}
                  >
                    <IconChevronRight size={ICON_SIZE.control} />
                  </IconButton>
                </div>
                {/* Weekday letters are visual only: every day cell's name is its full spoken date. */}
                <div
                  aria-hidden="true"
                  className="grid grid-cols-7 place-items-center gap-1 text-center text-xs text-fg-3"
                >
                  {WEEKDAYS.map((weekday, index) => (
                    <span key={`${weekday}-${index}`}>{weekday}</span>
                  ))}
                </div>
                <div
                  role="grid"
                  aria-label={`${MONTHS[view.monthIndex]} ${view.year}`}
                  onKeyDown={onGridKeyDown}
                  className="mt-1 grid grid-cols-7 place-items-center gap-1"
                >
                  {/* Week rows are display:contents, so the seven-column grid lays out as before. */}
                  {weekRows(
                    dayCells(view.year, view.monthIndex, value, todayISO, pick, minISO, tabISO),
                  ).map((week, index) => (
                    <div key={`week-${index}`} role="row" className="contents">
                      {week}
                    </div>
                  ))}
                </div>
                {actions ? (
                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                    <ClearButton disabled={value === ''} onClick={() => pick('')}>
                      Clear date
                    </ClearButton>
                    <Button
                      type="button"
                      variant="primary"
                      data-date-done=""
                      onClick={() => setOpen(false)}
                    >
                      Done
                    </Button>
                  </div>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

/** The calendar's own size: wide enough for seven 44px day cells, tall enough for 6 weeks and the actions. */
const POPOVER_MIN_WIDTH = 336;
const POPOVER_HEIGHT = 420;
const POPOVER_GAP = 6;
const VIEWPORT_EDGE = 8;

/**
 * Where the popover sits for a trigger rect: under it when the calendar fits
 * below, else above it; never wider than the screen and never past its edges.
 * Pure so it unit-tests without a DOM.
 */
export function popoverPlacement(
  trigger: { top: number; bottom: number; left: number; width: number },
  viewport: { width: number; height: number },
): { top?: number; bottom?: number; left: number; width: number } {
  const width = Math.min(
    Math.max(trigger.width, POPOVER_MIN_WIDTH),
    viewport.width - VIEWPORT_EDGE * 2,
  );
  const left = Math.min(
    Math.max(trigger.left, VIEWPORT_EDGE),
    viewport.width - VIEWPORT_EDGE - width,
  );
  const roomBelow = viewport.height - trigger.bottom - POPOVER_GAP - VIEWPORT_EDGE;
  if (roomBelow >= POPOVER_HEIGHT || trigger.top < POPOVER_HEIGHT + POPOVER_GAP) {
    return { top: trigger.bottom + POPOVER_GAP, left, width };
  }
  return { bottom: viewport.height - trigger.top + POPOVER_GAP, left, width };
}
