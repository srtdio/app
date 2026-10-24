// The plan day picker: every day of the plan as a 4-column tile grid (weekday
// caps, day number, then "{n} items" or the month in mono), today's weekday in
// accent, the selected tile filled accent, a warning dot on the post's current
// Pipeline day. A plan over more than one Mon-start week labels each week.
// "No date" sits under the tiles (hidden where a date cannot be cleared), then
// the footnote pointing at the plan dates. PlanDayTiles is the same grid drawn
// inline (the concept sheet). PlanDatesSheet edits the New plan's From and
// To (at most 5 weeks). No other dates: a plan only holds its own days.
// Tokens only; the Sheet's translateY motion only.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import { composeRangeProblem, type ComposeDay, type ComposeRange } from '@/lib/chat/plans';
import {
  civilDaysBetween,
  civilMondayOf,
  civilWeekdayShort,
  dayOfMonth,
  formatCivilDayHeader,
  formatCivilShort,
} from '@/lib/plan-week';

/** The tile's last line: "{n} items" when the day holds any, else the month. Pure. */
export function tileCaption(day: string, count: number): string {
  if (count > 0) return `${count} ${count === 1 ? 'item' : 'items'}`;
  return formatCivilShort(day).split(' ')[1] ?? '';
}

/** The plan's days in Mon-start weeks; a label per week only when there is more than one. Pure. */
export function dayTileWeeks(range: ComposeRange): Array<{ label: string | null; days: string[] }> {
  const weeks: Array<{ monday: string; days: string[] }> = [];
  for (const day of civilDaysBetween(range.startsOn, range.endsOn)) {
    const monday = civilMondayOf(day);
    const last = weeks[weeks.length - 1];
    if (last !== undefined && last.monday === monday) last.days.push(day);
    else weeks.push({ monday, days: [day] });
  }
  return weeks.map((w) => ({
    label: weeks.length > 1 ? `Week of ${formatCivilDayHeader(w.monday)}` : null,
    days: w.days,
  }));
}

export const NO_DATE_BUTTON = 'No date';
export const CURRENT_PIPELINE_DAY = 'Current Pipeline day';
export const LATER_DAY_FOOTNOTE = 'Need a later day? Close this and change the plan dates.';

export function PlanDayTiles(props: {
  range: ComposeRange;
  selected: ComposeDay;
  onPick: (day: string | 'none') => void;
  today: string;
  /** The post's current Pipeline day: a warning dot on its tile. */
  pipelineDay?: string | null;
  /** Items per day, shown on the tile. */
  counts?: Readonly<Record<string, number>>;
  /** Show the full-width No date button (default true). */
  noDate?: boolean;
  disabled?: boolean;
}): ReactElement {
  const pipelineInside =
    props.pipelineDay != null &&
    props.pipelineDay >= props.range.startsOn &&
    props.pipelineDay <= props.range.endsOn;
  return (
    <div data-plan-day-tiles="" className="flex flex-col gap-2">
      {dayTileWeeks(props.range).map((week) => (
        <div key={week.days[0]} className="flex flex-col gap-2">
          {week.label !== null ? (
            <p className="mt-0.5 text-sm font-semibold uppercase tracking-[0.04em] text-fg-3">
              {week.label}
            </p>
          ) : null}
          <div className="grid grid-cols-4 gap-2">
            {week.days.map((day) => {
              const on = props.selected === day;
              const count = props.counts?.[day] ?? 0;
              return (
                <button
                  key={day}
                  type="button"
                  data-plan-day-tile={day}
                  aria-pressed={on}
                  aria-label={formatCivilDayHeader(day)}
                  disabled={props.disabled === true}
                  onClick={() => props.onPick(day)}
                  className={cn(
                    'relative flex min-h-[62px] flex-col items-center justify-center gap-px rounded-xl border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60',
                    on
                      ? 'border-accent bg-accent text-accent-fg'
                      : 'border-border bg-panel text-fg',
                  )}
                >
                  <span
                    className={cn(
                      'text-xs font-semibold uppercase tracking-[0.06em]',
                      on ? 'text-accent-fg' : day === props.today ? 'text-accent' : 'text-fg-3',
                    )}
                  >
                    {civilWeekdayShort(day)}
                  </span>
                  <span className="font-mono text-2xl font-semibold leading-[1.15] tabular-nums">
                    {dayOfMonth(day)}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-xs tabular-nums',
                      on ? 'text-accent-fg' : 'text-fg-3',
                    )}
                  >
                    {tileCaption(day, count)}
                  </span>
                  {day === props.pipelineDay ? (
                    <span
                      aria-hidden="true"
                      data-plan-day-pipeline=""
                      className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {pipelineInside ? (
        <p className="flex items-center gap-1.5 text-sm text-fg-3">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warn" />
          {CURRENT_PIPELINE_DAY}
        </p>
      ) : null}
      {props.noDate !== false ? (
        <Button
          type="button"
          data-plan-day-none=""
          aria-pressed={props.selected === 'none'}
          disabled={props.disabled === true}
          onClick={() => props.onPick('none')}
          variant="secondary"
          className={cn(
            'w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            props.selected === 'none' && '!border-transparent !bg-accent-soft !text-accent',
          )}
        >
          {NO_DATE_BUTTON}
        </Button>
      ) : null}
    </div>
  );
}

/** The sheet's subline for a post or concept. Pure. */
export function dayPickerSubline(
  item: { kind: 'concept' } | { kind: 'post' | 'draft'; orig: string | null },
  range: ComposeRange,
): string {
  if (item.kind === 'concept') return 'Concept';
  if (item.orig === null) return 'No Pipeline date yet';
  const inside = item.orig >= range.startsOn && item.orig <= range.endsOn;
  return `In Pipeline: ${formatCivilDayHeader(item.orig)}${inside ? '' : ' (outside this plan)'}`;
}

export function PlanDayPickerSheet(props: {
  open: boolean;
  title: string;
  subline: string;
  range: ComposeRange;
  selected: ComposeDay;
  today: string;
  pipelineDay?: string | null;
  counts?: Readonly<Record<string, number>>;
  /** Hide No date and the footnote (no way to clear a date from here). */
  hideNoDate?: boolean;
  onPick: (day: string | 'none') => void;
  onClose: () => void;
}): ReactElement {
  const hide = props.hideNoDate === true;
  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title}>
      <div data-plan-day-picker="" className="flex flex-col gap-3">
        <p className="-mt-1 text-md text-fg-3">{props.subline}</p>
        <PlanDayTiles
          range={props.range}
          selected={props.selected}
          today={props.today}
          onPick={props.onPick}
          noDate={!hide}
          {...(props.pipelineDay !== undefined ? { pipelineDay: props.pipelineDay } : {})}
          {...(props.counts !== undefined ? { counts: props.counts } : {})}
        />
        {!hide ? (
          <p className="text-sm text-fg-3">{LATER_DAY_FOOTNOTE}</p>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * The From / To inputs shrink to their half of the row: WebKit's date input
 * keeps an intrinsic min width (and centres its value) unless its native look
 * is reset, which on a 320px iPhone pushed To past the screen edge.
 */
export const DATE_FIT =
  'block min-w-0 appearance-none [-webkit-appearance:none] [&::-webkit-date-and-time-value]:text-left [&::-webkit-date-and-time-value]:min-h-[1.5em] [&::-webkit-calendar-picker-indicator]:m-0';

/** The date inputs: the field look with a slimmer side padding so the date fits at 320px. */
export const DATE_FIELD = cn(
  'h-11 min-h-[44px] w-full rounded-lg border border-border bg-panel-2 px-2.5 text-base text-fg placeholder:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60',
  DATE_FIT,
  'font-mono text-lg',
);

export const PLAN_DATES_TITLE = 'Plan dates';
export const PLAN_DATES_HINT = 'Up to 5 weeks. Items on days you drop go back to "Pick a day".';
export const PLAN_DATES_SAVE = 'Save dates';

/** New plan's dates: From and To, checked on Save (end on or after start, 5 weeks max). */
export function PlanDatesSheet(props: {
  open: boolean;
  range: ComposeRange;
  onSave: (range: ComposeRange) => void;
  onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<ComposeRange>(props.range);
  const [error, setError] = useState<string | null>(null);
  const { open, range } = props;
  useEffect(() => {
    if (!open) return;
    setDraft(range);
    setError(null);
  }, [open, range]);
  const save = (): void => {
    const problem = composeRangeProblem(draft);
    if (problem !== null) {
      setError(problem);
      return;
    }
    props.onSave(draft);
  };
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={PLAN_DATES_TITLE}
      footer={
        <Button variant="primary" data-plan-dates-save="" className="w-full" onClick={save}>
          {PLAN_DATES_SAVE}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="-mt-1 text-md text-fg-3">{PLAN_DATES_HINT}</p>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['startsOn', 'From'],
              ['endsOn', 'To'],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="flex w-full min-w-0 flex-col gap-1">
              <span className="text-md text-fg-3">{label}</span>
              <input
                type="date"
                data-plan-date={field}
                value={draft[field]}
                onChange={(e) => {
                  const value = e.target.value;
                  setDraft((r) => ({ ...r, [field]: value }));
                  setError(null);
                }}
                className={DATE_FIELD}
              />
            </label>
          ))}
        </div>
        {error !== null ? (
          <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2.5 text-md text-bad">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
