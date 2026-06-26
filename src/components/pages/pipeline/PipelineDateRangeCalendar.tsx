// An iOS-style month calendar presented as a floating, centered MODAL. It sits
// ON TOP of the sort sheet/popover (higher z-index) and never pushes page
// content down: it portals to <body>, paints a fixed-inset scrim, and centres a
// card that fades + scales in (modal idiom, not a bottom-sheet slide). Range
// selection is two taps (start then end); a day before the current start swaps
// them; a single tap is a one-day range; tapping again when both are set
// restarts. Self-contained date math with native Date, ISO 'YYYY-MM-DD' only.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';

interface DateRange {
  start: string;
  end: string;
}

interface PipelineDateRangeCalendarProps {
  open: boolean;
  initialRange: DateRange | null;
  /** 0=Sun..6=Sat; the workspace's week_start_day orders the columns. */
  weekStartDay: number;
  onApply: (range: DateRange) => void;
  onClear: () => void;
  onClose: () => void;
}

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

// Indexed by day-of-week 0=Sun..6=Sat; the header rotates this by weekStartDay.
const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Compose an ISO 'YYYY-MM-DD' from a 0-based month index. */
function toISO(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

/** Parse an ISO 'YYYY-MM-DD' to a 0-based month index, or null when malformed. */
function parseISO(value: string): { year: number; monthIndex: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  return { year, monthIndex, day };
}

/** Move a (year, 0-based month) pair by delta months, carrying across years. */
function shiftMonth(
  year: number,
  monthIndex: number,
  delta: number,
): { year: number; monthIndex: number } {
  const total = year * 12 + monthIndex + delta;
  return { year: Math.floor(total / 12), monthIndex: ((total % 12) + 12) % 12 };
}

/**
 * Leading-null-padded day cells for a month grid, with the leading offset keyed
 * to weekStartDay (0=Sun..6=Sat). Pure so the grid shape is predictable.
 */
function monthGrid(year: number, monthIndex: number, weekStartDay: number): (number | null)[] {
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const offset = (((firstWeekday - weekStartDay) % 7) + 7) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  return cells;
}

export function PipelineDateRangeCalendar({
  open,
  initialRange,
  weekStartDay,
  onApply,
  onClear,
  onClose,
}: PipelineDateRangeCalendarProps): ReactElement | null {
  const now = new Date();
  const [start, setStart] = useState<string | null>(initialRange?.start ?? null);
  const [end, setEnd] = useState<string | null>(initialRange?.end ?? null);
  const seed = parseISO(initialRange?.start ?? '') ?? {
    year: now.getFullYear(),
    monthIndex: now.getMonth(),
  };
  const [view, setView] = useState<{ year: number; monthIndex: number }>({
    year: seed.year,
    monthIndex: seed.monthIndex,
  });
  // Mount flag drives the fade + scale: it flips on the tick after open so the
  // card transitions from its hidden state to its shown state.
  const [shown, setShown] = useState(false);

  // Re-seed the selection and the visible month each time the modal opens, so a
  // re-open lands on the saved range rather than stale local state.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    setStart(initialRange?.start ?? null);
    setEnd(initialRange?.end ?? null);
    const parsed = parseISO(initialRange?.start ?? '');
    if (parsed !== null) setView({ year: parsed.year, monthIndex: parsed.monthIndex });
    setShown(true);
  }, [open, initialRange?.start, initialRange?.end]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const todayISO = toISO(now.getFullYear(), now.getMonth(), now.getDate());

  function pick(iso: string): void {
    if (start === null || end !== null) {
      // No range yet, or both endpoints set: (re)start the range.
      setStart(iso);
      setEnd(null);
      return;
    }
    if (iso < start) {
      // A day before the current start swaps the endpoints.
      setEnd(start);
      setStart(iso);
      return;
    }
    setEnd(iso);
  }

  const weekdayHeader = Array.from(
    { length: 7 },
    (_unused, i) => WEEKDAY_LETTERS[(weekStartDay + i) % 7],
  );
  const cells = monthGrid(view.year, view.monthIndex, weekStartDay);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className={cn(
          'absolute inset-0 bg-black/45 transition-opacity duration-150',
          shown ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select a date range"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'relative w-[320px] max-w-full rounded-2xl border border-border-strong bg-panel p-3 shadow-2xl transition-all duration-150',
          shown ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
        )}
      >
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setView((v) => shiftMonth(v.year, v.monthIndex, -1))}
            className="flex h-11 w-11 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <IconChevronLeft size={18} />
          </button>
          <span className="text-sm font-semibold text-fg">
            {MONTHS[view.monthIndex]} {view.year}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setView((v) => shiftMonth(v.year, v.monthIndex, 1))}
            className="flex h-11 w-11 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <IconChevronRight size={18} />
          </button>
        </div>

        <div className="grid grid-cols-7 text-center text-[11px] font-medium text-fg-3">
          {weekdayHeader.map((letter, index) => (
            <span key={`${letter}-${index}`} className="py-1">
              {letter}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {cells.map((day, index) => {
            if (day === null) return <span key={`blank-${index}`} aria-hidden="true" />;
            const iso = toISO(view.year, view.monthIndex, day);
            const isStart = iso === start;
            const isEnd = end !== null && iso === end;
            const single = start !== null && end === null && iso === start;
            const isEndpoint = isStart || isEnd;
            const between = start !== null && end !== null && iso > start && iso < end;
            const isToday = iso === todayISO;
            return (
              <button
                key={iso}
                type="button"
                aria-pressed={isEndpoint || single}
                onClick={() => pick(iso)}
                className={cn(
                  'flex min-h-[44px] items-center justify-center font-mono text-sm tabular-nums transition-colors',
                  isEndpoint
                    ? 'rounded-md bg-accent font-semibold text-accent-fg'
                    : between
                      ? 'bg-accent-soft text-accent'
                      : 'rounded-md text-fg hover:bg-panel-2',
                  !isEndpoint && !between && isToday ? 'ring-1 ring-inset ring-accent-line' : '',
                )}
              >
                {day}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-panel px-3 text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={start === null}
            onClick={() => {
              if (start === null) return;
              onApply({ start, end: end ?? start });
            }}
            className="flex h-11 flex-1 items-center justify-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
