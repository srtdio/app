// The Plan set-date sheet: tapping a tile's calendar button opens this to move
// the post onto a day of the week on screen (or to clear its date). It is
// presentational only - it never calls post_update itself; a pick calls up to
// PipelinePage, which owns the proc call, the toast and the reload.
//
// The picked value handed up is a CIVIL date ('YYYY-MM-DD') or null; turning it
// into a stored instant (noon in the workspace zone) is the page's job, so this
// sheet never builds a zoned instant of its own.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { addCivilDays } from '@/lib/list-sort';
import {
  PLAN_WEEK_DAYS,
  civilToday,
  dayOfMonth,
  formatCivilShort,
  groupByCivilDay,
  weekdayName,
} from '@/lib/plan-week';

/** The minimum a post needs for this sheet; PipelinePost satisfies it. */
export interface SetDatePost {
  id: string;
  title: string;
  target_date: string | null;
}

export interface SetDateSheetProps {
  open: boolean;
  /** The post being dated; null renders nothing (closed). */
  post: SetDatePost | null;
  /** First civil day of the week on screen; the seven buttons step from it. */
  weekStart: string;
  /** The workspace IANA zone: which day the current date reads as, and today. */
  timeZone: string;
  /** The workspace week start, 0=Sun..6=Sat; names the seven buttons. */
  weekStartDay: number;
  /** A picked civil date, or null to clear. Never the proc, never an instant. */
  onPick: (targetDate: string | null) => void;
  onClose: () => void;
  /** Disables every control while the write is in flight. */
  saving?: boolean;
}

/**
 * The seven civil days of the week on screen, start first. Pure string steps
 * (addCivilDays is UTC-anchored), so no zoned instant is ever built here.
 */
export function sheetDays(weekStart: string): string[] {
  return Array.from({ length: PLAN_WEEK_DAYS }, (_unused, i) => addCivilDays(weekStart, i));
}

/**
 * Which of the week's days the post currently sits on, or null when it is
 * undated or dated outside this week. Reuses groupByCivilDay so the day is read
 * in the WORKSPACE zone with the same (zone-validated) rule the grid uses.
 */
export function currentCivilDay(
  post: SetDatePost,
  days: string[],
  timeZone: string,
): string | null {
  const { byDay } = groupByCivilDay([post], days, timeZone);
  return days.find((day) => (byDay[day] ?? []).length > 0) ?? null;
}

/**
 * Bottom sheet (centered dialog on desktop) offering the week's seven days, a
 * native date input for anything else, and Clear date when the post is dated.
 * Reuses the shared Sheet chrome exactly as MoveSheet does; every control is a
 * >=44px target and every colour comes through a token class, so light/dark
 * parity tracks index.css.
 */
export function SetDateSheet({
  open,
  post,
  weekStart,
  timeZone,
  weekStartDay,
  onPick,
  onClose,
  saving = false,
}: SetDateSheetProps): ReactElement | null {
  // Revealed by "Another date"; a native input is the only date entry, mirroring
  // PostDetailsSheet. Hook order is stable because the null-post bail is below.
  const [otherOpen, setOtherOpen] = useState(false);

  if (post === null) {
    return null;
  }

  const days = sheetDays(weekStart);
  const current = currentCivilDay(post, days, timeZone);
  const today = civilToday(new Date(), timeZone);
  const dated = post.target_date !== null;

  return (
    <Sheet open={open} onClose={onClose} title="Set target date">
      <div className="flex flex-col gap-3">
        <div>
          <div className="text-xs text-fg-3">
            Set target date, {formatCivilShort(weekStart)} to{' '}
            {formatCivilShort(days[PLAN_WEEK_DAYS - 1]!)}
          </div>
          <div className="mt-1 truncate text-sm font-medium">{post.title}</div>
        </div>

        <div className="grid grid-cols-7 gap-1">
          {days.map((day, index) => {
            const isCurrent = day === current;
            return (
              <button
                key={day}
                type="button"
                data-set-date-day={day}
                aria-pressed={isCurrent}
                disabled={saving}
                onClick={() => onPick(day)}
                className={cn(
                  'flex min-h-[56px] flex-col items-center justify-center gap-0.5 rounded-lg border px-1',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
                  isCurrent ? 'border-accent-line bg-accent-soft' : 'border-border bg-panel-2',
                )}
              >
                <span className={cn('text-[11px]', day === today ? 'text-accent' : 'text-fg-3')}>
                  {weekdayName(weekStartDay, index)}
                </span>
                <span
                  className={cn(
                    'text-sm tabular-nums',
                    day === today ? 'text-accent' : 'text-fg-2',
                  )}
                >
                  {dayOfMonth(day)}
                </span>
              </button>
            );
          })}
        </div>

        {otherOpen ? (
          <input
            type="date"
            aria-label="Another date"
            disabled={saving}
            defaultValue={current ?? ''}
            onChange={(event) => {
              if (event.target.value !== '') onPick(event.target.value);
            }}
            className="min-h-[44px] w-full rounded-md border border-border bg-panel-2 px-3 text-sm text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft disabled:opacity-50"
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" disabled={saving} onClick={() => setOtherOpen(true)}>
            Another date
          </Button>
          {dated ? (
            <Button size="lg" className="text-bad" disabled={saving} onClick={() => onPick(null)}>
              Clear date
            </Button>
          ) : null}
          <span className="ml-auto">
            <Button variant="ghost" size="lg" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
          </span>
        </div>
      </div>
    </Sheet>
  );
}
