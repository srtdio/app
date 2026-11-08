import { useMemo, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { CHIP_PICKED_EDGE, CHIP_REST_EDGE } from '@/components/ui/Chip';
import { useIsLaptop } from '@/lib/use-is-laptop';
import {
  backdropMonth,
  backdropMonthLabel,
  backdropThumbSrc,
  backdropWeekdays,
  type BackdropCell,
} from '@/components/auth/plan-backdrop-data';

/**
 * Decorative, blurred Plan month behind the auth card. It carries no copy
 * beyond the month label, weekday labels and day numbers, and is hidden from
 * screen readers. It renders its final state at once and never fades (motion
 * law: final state first, nothing held hidden waiting for images); the
 * low-priority thumbnails simply land in place behind the blur.
 */
export function PlanBackdrop(): ReactElement {
  const isLaptop = useIsLaptop();
  const today = useMemo(() => new Date(), []);
  const weeks = useMemo(() => backdropMonth(today), [today]);
  const weekdays = useMemo(() => backdropWeekdays(), []);
  const monthLabel = useMemo(() => backdropMonthLabel(today), [today]);

  return (
    <div
      aria-hidden="true"
      data-plan-backdrop=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        data-plan-backdrop-layer=""
        className="absolute -inset-8 scale-[1.03] [filter:blur(6px)] md:[filter:blur(8px)]"
      >
        {isLaptop ? (
          <LaptopPlan weeks={weeks} weekdays={weekdays} monthLabel={monthLabel} />
        ) : (
          <PhonePlan weeks={weeks} weekdays={weekdays} monthLabel={monthLabel} />
        )}
      </div>
      <div className="absolute inset-0 bg-bg/50" />
    </div>
  );
}

interface PlanProps {
  weeks: BackdropCell[][];
  weekdays: string[];
  monthLabel: string;
}

// React 18 has no camelCase fetchPriority prop; the lowercase attribute
// passes through to the DOM without a warning.
const LOW_FETCH_PRIORITY: Record<string, string> = { fetchpriority: 'low' };

function Thumb({ thumb, className }: { thumb: string; className: string }): ReactElement {
  return (
    <img
      src={backdropThumbSrc(thumb)}
      alt=""
      decoding="async"
      {...LOW_FETCH_PRIORITY}
      draggable={false}
      className={cn('h-full w-full object-cover rounded-sm border border-border', className)}
    />
  );
}

function Bar({ className }: { className: string }): ReactElement {
  return <span className={cn('block rounded-full bg-panel-3', className)} />;
}

function Chips(): ReactElement {
  return (
    <div className="flex gap-2">
      <span
        data-backdrop-chip=""
        className={cn('h-7 w-20 rounded-full border', CHIP_PICKED_EDGE)}
      />
      <span data-backdrop-chip="" className={cn('h-7 w-16 rounded-full border', CHIP_REST_EDGE)} />
      <span data-backdrop-chip="" className={cn('h-7 w-24 rounded-full border', CHIP_REST_EDGE)} />
      <span data-backdrop-chip="" className={cn('h-7 w-14 rounded-full border', CHIP_REST_EDGE)} />
    </div>
  );
}

function DayNumber({ cell, className }: { cell: BackdropCell; className: string }): ReactElement {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold',
        cell.isToday ? 'bg-accent text-accent-fg' : cell.inMonth ? 'text-fg' : 'text-fg-3',
        className,
      )}
    >
      {cell.day}
    </span>
  );
}

function LaptopPlan({ weeks, weekdays, monthLabel }: PlanProps): ReactElement {
  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-10">
        <Bar className="h-3 w-24" />
        <span className="flex-1" />
        <Bar className="h-8 w-56" />
        <span className="h-8 w-8 rounded-full bg-panel-3" />
      </div>
      <div className="shrink-0 px-10 pt-6">
        <Chips />
      </div>
      <div className="flex shrink-0 items-center gap-3 px-10 py-4">
        <span className="text-xl font-semibold text-fg">{monthLabel}</span>
        <span className="h-8 w-8 rounded-lg bg-panel-2" />
        <span className="h-8 w-8 rounded-lg bg-panel-2" />
        <span className="flex-1" />
        <span className="h-8 w-36 rounded-lg bg-panel-2" />
      </div>
      <div className="mx-10 mb-10 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
        <div className="grid shrink-0 grid-cols-7 border-b border-border bg-panel-2">
          {weekdays.map((label) => (
            <span key={label} className="px-2 py-2 text-sm font-semibold text-fg-3">
              {label}
            </span>
          ))}
        </div>
        {weeks.map((week, row) => (
          <div key={row} className="grid min-h-0 flex-1 grid-cols-7">
            {week.map((cell, col) => (
              <div
                key={col}
                className={cn(
                  'flex min-w-0 flex-col gap-1 overflow-hidden border-b border-r border-border p-1 last:border-r-0',
                  cell.inMonth ? 'bg-panel' : 'bg-panel-2',
                )}
              >
                <DayNumber cell={cell} className="h-6 w-6 text-sm" />
                <Thumb thumb={cell.thumb} className="h-12 w-full" />
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                  <Bar className="h-2 w-3/4" />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhonePlan({ weeks, weekdays, monthLabel }: PlanProps): ReactElement {
  const listThumbs = weeks[1]?.slice(0, 3) ?? [];
  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-12">
        <Bar className="h-3 w-20" />
        <span className="flex-1" />
        <span className="h-8 w-8 rounded-full bg-panel-3" />
      </div>
      <div className="shrink-0 overflow-hidden px-12 pt-4">
        <Chips />
      </div>
      <div className="shrink-0 px-12 py-3 text-lg font-semibold text-fg">{monthLabel}</div>
      <div className="mx-12 shrink-0 overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-7 border-b border-border bg-panel-2">
          {weekdays.map((label) => (
            <span key={label} className="py-1 text-center text-xs font-semibold text-fg-3">
              {label.charAt(0)}
            </span>
          ))}
        </div>
        {weeks.map((week, row) => (
          <div key={row} className="grid grid-cols-7">
            {week.map((cell, col) => (
              <div
                key={col}
                className={cn(
                  'flex min-w-0 flex-col items-center gap-1 border-b border-r border-border p-1 last:border-r-0',
                  cell.inMonth ? 'bg-panel' : 'bg-panel-2',
                )}
              >
                <DayNumber cell={cell} className="h-5 w-5 text-xs" />
                <Thumb thumb={cell.thumb} className="h-10 w-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* The app's flat list rows (flat look): rows touching, no card frame. */}
      <div className="mx-12 mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        {listThumbs.map((cell) => (
          <div
            key={`${cell.day}-${cell.inMonth ? 'in' : 'out'}`}
            className="flex items-center gap-3 py-2"
          >
            <Thumb thumb={cell.thumb} className="h-10 w-10 shrink-0" />
            <Bar className="h-3 w-1/2" />
          </div>
        ))}
      </div>
      <div className="flex h-24 shrink-0 items-start justify-around border-t border-border bg-panel px-12 pt-4">
        {[0, 1, 2, 3, 4].map((tab) => (
          <span key={tab} className="h-5 w-5 rounded-lg bg-panel-3" />
        ))}
      </div>
    </div>
  );
}
