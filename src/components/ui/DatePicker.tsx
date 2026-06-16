// A custom in-app calendar control. A native <input type="date"> overflows the
// sheet, so this matches the Select look (h-11 trigger, calendar icon, the
// selected date left-aligned or a placeholder) and opens a small month-grid
// popover (prev/next month, day cells, a today marker, the selected day on
// accent). Controlled by an ISO yyyy-mm-dd string (empty = no selection). The
// date math and the day cells are pure helpers so they unit-test without a DOM.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';

// No calendar glyph exists in src/components/ui/icons, so a minimal inline svg
// lives here (matching the shared Svg stroke conventions).
function IconCalendar({ className, size = 18 }: IconProps): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={4} y={5} width={16} height={16} rx={2} />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </svg>
  );
}

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
 * Day cell buttons for the calendar grid. The selected day uses the accent fill;
 * today (when not selected) carries an accent ring. Pure (no hooks) so picking a
 * day and the markers are unit-testable.
 */
export function dayCells(
  year: number,
  monthIndex: number,
  selectedISO: string,
  todayISO: string,
  onPick: (iso: string) => void,
): ReactElement[] {
  return monthGrid(year, monthIndex).map((day, index) => {
    if (day === null) return <span key={`blank-${index}`} aria-hidden="true" />;
    const iso = toISO(year, monthIndex, day);
    const selected = iso === selectedISO;
    const isToday = iso === todayISO;
    return (
      <button
        key={iso}
        type="button"
        role="gridcell"
        aria-selected={selected}
        onClick={() => onPick(iso)}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors',
          selected ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-panel-2',
          !selected && isToday ? 'border border-accent-line' : '',
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
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Select a date',
  label,
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

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(iso: string): void {
    onChange(iso);
    setOpen(false);
  }

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        {...(label !== undefined ? { 'aria-label': label } : {})}
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-panel-2 px-3 text-sm transition-colors hover:bg-panel-3"
      >
        <IconCalendar size={16} className="shrink-0 text-fg-3" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            value !== '' ? 'text-fg' : 'text-fg-3',
          )}
        >
          {value !== '' ? formatDisplay(value) : placeholder}
        </span>
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Choose a date"
            className="absolute left-0 top-full z-50 mt-1.5 w-full min-w-0 rounded-xl border border-border-strong bg-panel p-2 shadow-2xl"
          >
            <div className="mb-1 flex items-center justify-between">
              <IconButton
                label="Previous month"
                onClick={() => setView((v) => shiftMonth(v.year, v.monthIndex, -1))}
              >
                <IconChevronLeft size={16} />
              </IconButton>
              <span className="text-sm font-medium text-fg">
                {MONTHS[view.monthIndex]} {view.year}
              </span>
              <IconButton
                label="Next month"
                onClick={() => setView((v) => shiftMonth(v.year, v.monthIndex, 1))}
              >
                <IconChevronRight size={16} />
              </IconButton>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-fg-3">
              {WEEKDAYS.map((weekday, index) => (
                <span key={`${weekday}-${index}`}>{weekday}</span>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 place-items-center gap-0.5">
              {dayCells(view.year, view.monthIndex, value, todayISO, pick)}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
