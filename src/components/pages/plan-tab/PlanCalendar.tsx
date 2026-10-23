// The Plan tab on a laptop: the chip row (All, then one chip per plan in the
// range, in its colour, Draft tagged), the toolbar (range label, Last /
// Next, Today, the legend) and the Month or Week grid. Colour is which plan: a
// plan item sits on its plan's soft colour with a round dot; a dated post in
// no plan on the neutral panel with a square dot. A month cell shows three
// entries then "+N more" (that day's week). The week shows each entry as a
// card: tile, title, plan, the Plan pill and the post line. A chip filters
// both views. Creators drag an entry to another day (a 4px pointer travel
// lifts it: a lifted card follows the pointer, the day under it shows a dashed
// drop outline when the move is allowed; Escape cancels) and click an empty
// part of a day for the Add on menu; approvers get neither. A click opens the
// entry: a plan item in the docked Plan screen, a post on its page. While the
// range reads, the grid keeps its final size. Tokens only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react';
import { PlanKeepApprovalSheet } from '@/components/chat/PlanMoveSheet';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { rowTitle } from '@/components/chat/PlanScreen';
import { Thumbnail } from '@/components/media/Thumbnail';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import {
  ALL_LABEL,
  LOOSE_POST_CLASSES,
  LOOSE_POST_LEGEND,
  PLAN_ITEM_LEGEND,
  PLAN_TONE_CLASSES,
  TODAY_LABEL,
  calendarEntries,
  canDragEntries,
  canDropOn,
  canOpenDayMenu,
  capEntries,
  isDraftPlan,
  monthGrid,
  moreLabel,
  planPill,
  planTones,
  plansCovering,
  plansInToneOrder,
  postStageLine,
  rangeLabel,
  shiftAnchor,
  weekDays,
  weekRangeOf,
  type CalendarEntry,
  type LoosePost,
  type PlanTabView,
  type PlanTone,
} from '@/lib/plan-tab';
import { civilDayOf, civilWeekdayShort, dayOfMonth, formatCivilDayHeader } from '@/lib/plan-week';
import { PlanDayMenu } from './PlanDayMenu';
import { DraftTag } from './PlanTabList';
import type { AddTarget } from './PlanTabAdd';
import { usePlanTabMove } from './use-plan-tab-move';

/** Pointer travel (px) that lifts an entry into a drag. */
export const DRAG_SLOP_PX = 4;

/** The calendar's data: the plans in the range and the dated posts in no plan. */
export interface CalendarData {
  bundles: readonly PlanBundle[];
  posts: readonly LoosePost[];
  thumbs: PlanThumbs;
}

const EMPTY_DATA: CalendarData = { bundles: [], posts: [], thumbs: { posts: {}, concepts: {} } };

interface Drag {
  entry: CalendarEntry;
  x: number;
  y: number;
  offX: number;
  offY: number;
  width: number;
  over: string | null;
}

/** The day cell under a point, if any. */
function dayAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest('[data-plan-tab-day]')?.getAttribute('data-plan-tab-day') ?? null;
}

/** Whether a click landed on an entry, a button or a link inside a day (not its empty part). */
function onControl(event: { target: EventTarget | null }): boolean {
  const el = event.target as HTMLElement | null;
  return el?.closest('button, a, [data-plan-tab-entry]') != null;
}

export function PlanCalendar(props: {
  view: PlanTabView;
  anchor: string;
  today: string;
  timeZone: string;
  side: ViewerSide;
  /** Null while the range reads (the grid keeps its size). */
  data: CalendarData | null;
  onAnchor: (anchor: string) => void;
  /** "+N more": that day's week in the Week view. */
  onWeekOf: (day: string) => void;
  onOpen: (entry: CalendarEntry) => void;
  onAddTo: (target: AddTarget) => void;
  onNewPlan: (range: { startsOn: string; endsOn: string }) => void;
  reload: () => Promise<void>;
}): ReactElement {
  const { view, anchor, today, timeZone, side } = props;
  const data = props.data ?? EMPTY_DATA;
  const bundles = data.bundles;
  const tones = useMemo(() => planTones(bundles.map((b) => b.plan)), [bundles]);
  const [filter, setFilter] = useState<string | null>(null);
  const shownFilter = filter !== null && bundles.some((b) => b.plan.id === filter) ? filter : null;
  const mover = usePlanTabMove({ timeZone, reload: props.reload });
  const entries = useMemo(
    () =>
      calendarEntries({
        bundles,
        posts: data.posts,
        tones,
        timeZone,
        filter: shownFilter,
        titleOf: rowTitle,
        dayOfPost: (p) => civilDayOf(p.target_date, timeZone),
        overrides: mover.overrides,
      }),
    [bundles, data.posts, tones, timeZone, shownFilter, mover.overrides],
  );
  const [menu, setMenu] = useState<{ day: string; anchor: HTMLElement } | null>(null);
  const draggable = canDragEntries(side);
  const drag = useEntryDrag({ enabled: draggable, onDrop: mover.move });

  const openEntry = (entry: CalendarEntry): void => {
    if (drag.consumeClick()) return;
    props.onOpen(entry);
  };
  const dayClick = (day: string, cell: HTMLElement, event: ReactMouseEvent): void => {
    if (drag.consumeClick() || onControl(event) || !canOpenDayMenu(side)) return;
    setMenu({ day, anchor: cell });
  };
  const dayKey = (day: string, event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget || !canOpenDayMenu(side)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setMenu({ day, anchor: event.currentTarget });
  };
  const cellProps = (day: string): CellProps => ({
    day,
    today,
    over: drag.state?.over === day,
    addable: canOpenDayMenu(side),
    onClick: dayClick,
    onKeyDown: dayKey,
  });
  const entryProps = (entry: CalendarEntry): EntryProps => ({
    entry,
    lifted: drag.state?.entry.key === entry.key,
    draggable,
    onOpen: openEntry,
    onPointerDown: drag.press,
  });

  return (
    <div
      data-plan-tab="desktop"
      data-plan-tab-loading={props.data === null ? '' : undefined}
      className={cn('flex flex-col', drag.state !== null && 'select-none')}
    >
      <ChipRow bundles={bundles} tones={tones} selected={shownFilter} onSelect={setFilter} />
      <div className="flex flex-wrap items-center gap-2 px-6 py-2">
        <h2 data-plan-tab-range="" className="mr-1 text-[15px] font-semibold text-fg">
          {rangeLabel(view, anchor)}
        </h2>
        <IconButton
          label={view === 'month' ? 'Last month' : 'Last week'}
          data-plan-tab-prev=""
          onClick={() => props.onAnchor(shiftAnchor(view, anchor, -1))}
        >
          <IconChevronLeft size={18} />
        </IconButton>
        <IconButton
          label={view === 'month' ? 'Next month' : 'Next week'}
          data-plan-tab-next=""
          onClick={() => props.onAnchor(shiftAnchor(view, anchor, 1))}
        >
          <IconChevronRight size={18} />
        </IconButton>
        <Button size="lg" data-plan-tab-go-today="" onClick={() => props.onAnchor(today)}>
          {TODAY_LABEL}
        </Button>
        <div className="ml-auto flex items-center gap-4 text-xs text-fg-2">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
            {PLAN_ITEM_LEGEND}
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-sm', LOOSE_POST_CLASSES.dot)} />
            {LOOSE_POST_LEGEND}
          </span>
        </div>
      </div>
      {view === 'month' ? (
        <MonthGrid
          anchor={anchor}
          entries={entries}
          cellProps={cellProps}
          entryProps={entryProps}
          onMore={props.onWeekOf}
        />
      ) : (
        <WeekGrid
          anchor={anchor}
          today={today}
          entries={entries}
          thumbs={data.thumbs}
          cellProps={cellProps}
          entryProps={entryProps}
        />
      )}
      {drag.state !== null ? <LiftedEntry drag={drag.state} /> : null}
      {menu !== null ? (
        <PlanDayMenu
          day={menu.day}
          anchor={menu.anchor}
          plans={plansCovering(bundles, menu.day)}
          tones={tones}
          onPick={(bundle) => {
            setMenu(null);
            props.onAddTo({ bundle, day: menu.day });
          }}
          onNewPlan={() => {
            setMenu(null);
            props.onNewPlan(weekRangeOf(menu.day));
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      <PlanKeepApprovalSheet
        open={mover.keepAsk !== null}
        title={mover.keepAsk?.title ?? ''}
        body={mover.keepAsk?.body ?? ''}
        onKeep={mover.answerKeep}
        onCancel={mover.cancelKeep}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const CHIP =
  'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const CHIP_IDLE = 'border-border text-fg-2 hover:bg-panel-2';
const CHIP_ON = 'border-accent-line bg-accent-soft text-accent';

function ChipRow(props: {
  bundles: readonly PlanBundle[];
  tones: ReadonlyMap<string, PlanTone>;
  selected: string | null;
  onSelect: (planId: string | null) => void;
}): ReactElement {
  return (
    <div className="flex gap-2 overflow-x-auto px-6 pt-3">
      <button
        type="button"
        data-plan-tab-chip="all"
        aria-pressed={props.selected === null}
        onClick={() => props.onSelect(null)}
        className={cn(CHIP, props.selected === null ? CHIP_ON : CHIP_IDLE)}
      >
        {ALL_LABEL}
      </button>
      {plansInToneOrder(props.bundles.map((b) => b.plan)).map((plan) => {
        const on = props.selected === plan.id;
        return (
          <button
            key={plan.id}
            type="button"
            data-plan-tab-chip={plan.id}
            aria-pressed={on}
            onClick={() => props.onSelect(plan.id)}
            className={cn(CHIP, 'max-w-[260px]', on ? CHIP_ON : CHIP_IDLE)}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-2.5 w-2.5 shrink-0 rounded-full',
                PLAN_TONE_CLASSES[props.tones.get(plan.id) ?? 'accent'].dot,
              )}
            />
            <span className="truncate">{plan.title}</span>
            {isDraftPlan(plan) ? <DraftTag /> : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Days and entries
// ---------------------------------------------------------------------------

interface CellProps {
  day: string;
  today: string;
  over: boolean;
  /** A creator: an empty part of the day opens the Add on menu. */
  addable: boolean;
  onClick: (day: string, cell: HTMLElement, event: ReactMouseEvent) => void;
  onKeyDown: (day: string, event: ReactKeyboardEvent<HTMLElement>) => void;
}

interface EntryProps {
  entry: CalendarEntry;
  lifted: boolean;
  draggable: boolean;
  onOpen: (entry: CalendarEntry) => void;
  onPointerDown: (entry: CalendarEntry, event: ReactPointerEvent<HTMLElement>) => void;
}

/** A day's own attributes: the drop target, keyboard reach, the empty-part click. */
function dayAttrs(props: CellProps): {
  'data-plan-tab-day': string;
  'data-plan-tab-drop'?: string;
  'data-plan-tab-addable'?: string;
  tabIndex: number;
  'aria-label': string;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
} {
  return {
    'data-plan-tab-day': props.day,
    ...(props.over ? { 'data-plan-tab-drop': '' } : {}),
    ...(props.addable ? { 'data-plan-tab-addable': '' } : {}),
    tabIndex: 0,
    'aria-label': formatCivilDayHeader(props.day),
    onClick: (event) => props.onClick(props.day, event.currentTarget, event),
    onKeyDown: (event) => props.onKeyDown(props.day, event),
  };
}

const DAY_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';
const DROP = 'outline-dashed outline-2 -outline-offset-4 outline-accent';

function MonthGrid(props: {
  anchor: string;
  entries: ReadonlyMap<string, CalendarEntry[]>;
  cellProps: (day: string) => CellProps;
  entryProps: (entry: CalendarEntry) => EntryProps;
  onMore: (day: string) => void;
}): ReactElement {
  const weeks = monthGrid(props.anchor);
  return (
    <div
      data-plan-tab-month=""
      className="mx-6 mb-6 overflow-hidden rounded-lg border border-border"
    >
      <div className="grid grid-cols-7 border-b border-border bg-panel-2">
        {weeks[0]?.map((cell) => (
          <span key={cell.day} className="px-2 py-1.5 text-xs font-semibold text-fg-3">
            {civilWeekdayShort(cell.day)}
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]?.day} className="grid grid-cols-7">
          {week.map((cell) => {
            const cp = props.cellProps(cell.day);
            const { shown, more } = capEntries(props.entries.get(cell.day) ?? []);
            const isToday = cell.day === cp.today;
            return (
              <div
                key={cell.day}
                {...dayAttrs(cp)}
                data-plan-tab-out={cell.inMonth ? undefined : ''}
                className={cn(
                  'flex h-[128px] min-w-0 flex-col gap-0.5 border-b border-r border-border p-1.5 last:border-r-0',
                  cell.inMonth ? 'bg-panel' : 'bg-panel-2',
                  DAY_FOCUS,
                  cp.over && DROP,
                )}
              >
                <span
                  data-plan-tab-today={isToday ? '' : undefined}
                  className={cn(
                    'mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    isToday ? 'bg-accent text-accent-fg' : cell.inMonth ? 'text-fg' : 'text-fg-3',
                  )}
                >
                  {dayOfMonth(cell.day)}
                </span>
                {shown.map((entry) => (
                  <MonthEntry key={entry.key} {...props.entryProps(entry)} />
                ))}
                {more > 0 ? (
                  <button
                    type="button"
                    data-plan-tab-more={cell.day}
                    onClick={() => props.onMore(cell.day)}
                    className="h-[18px] shrink-0 self-start rounded px-1.5 text-[11px] font-medium leading-[18px] text-fg-2 hover:bg-panel-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {moreLabel(more)}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** An entry's tone classes: its plan's soft colour and round dot, or the neutral square. */
function entryLook(entry: CalendarEntry): { soft: string; dot: string } {
  if (entry.kind === 'post')
    return { soft: LOOSE_POST_CLASSES.soft, dot: cn(LOOSE_POST_CLASSES.dot, 'rounded-sm') };
  const tone = PLAN_TONE_CLASSES[entry.tone];
  return { soft: tone.soft, dot: cn(tone.dot, 'rounded-full') };
}

function MonthEntry(props: EntryProps): ReactElement {
  const look = entryLook(props.entry);
  return (
    <button
      type="button"
      data-plan-tab-entry={props.entry.key}
      data-plan-tab-lifted={props.lifted ? '' : undefined}
      data-plan-tab-draggable={props.draggable ? '' : undefined}
      onPointerDown={
        props.draggable ? (event) => props.onPointerDown(props.entry, event) : undefined
      }
      onClick={() => props.onOpen(props.entry)}
      className={cn(
        'flex h-[22px] w-full min-w-0 shrink-0 items-center gap-1.5 rounded px-1.5 text-left text-xs leading-[22px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        look.soft,
        props.lifted && 'opacity-40',
      )}
    >
      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0', look.dot)} />
      <span className="truncate">{props.entry.title}</span>
    </button>
  );
}

function WeekGrid(props: {
  anchor: string;
  today: string;
  entries: ReadonlyMap<string, CalendarEntry[]>;
  thumbs: PlanThumbs;
  cellProps: (day: string) => CellProps;
  entryProps: (entry: CalendarEntry) => EntryProps;
}): ReactElement {
  const days = weekDays(props.anchor);
  return (
    <div
      data-plan-tab-week=""
      className="mx-6 mb-6 overflow-hidden rounded-lg border border-border"
    >
      <div className="grid grid-cols-7 border-b border-border bg-panel-2">
        {days.map((day) => (
          <span
            key={day}
            className="flex items-baseline gap-1.5 px-2 py-1.5 text-xs font-semibold text-fg-3"
          >
            {civilWeekdayShort(day)}
            <span
              data-plan-tab-today={day === props.today ? '' : undefined}
              className={cn('text-sm', day === props.today ? 'text-accent' : 'text-fg')}
            >
              {dayOfMonth(day)}
            </span>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const cp = props.cellProps(day);
          return (
            <div
              key={day}
              {...dayAttrs(cp)}
              className={cn(
                'flex min-h-[520px] min-w-0 flex-col gap-2 border-r border-border bg-panel p-2 last:border-r-0',
                DAY_FOCUS,
                cp.over && DROP,
              )}
            >
              {(props.entries.get(day) ?? []).map((entry) => (
                <WeekCard key={entry.key} {...props.entryProps(entry)} thumbs={props.thumbs} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PILL_TONES = {
  good: 'bg-[var(--good-solid)] text-white',
  bad: 'bg-[var(--bad-solid)] text-white',
  neutral: 'bg-panel-2 text-fg-2',
} as const;

/** The card's tile: the post's cover, else the plan-coloured (or neutral) soft tile. */
function cardCover(entry: CalendarEntry, thumbs: PlanThumbs): string | null {
  if (entry.kind === 'post') return thumbs.posts[entry.post.id] ?? null;
  const postId = entry.item.post_id;
  return postId !== null ? (thumbs.posts[postId] ?? null) : null;
}

function WeekCard(props: EntryProps & { thumbs: PlanThumbs }): ReactElement {
  const { entry } = props;
  const look = entryLook(entry);
  const cover = cardCover(entry, props.thumbs);
  const pill = entry.kind === 'item' ? planPill(entry.bundle, entry.item) : null;
  return (
    <button
      type="button"
      data-plan-tab-entry={entry.key}
      data-plan-tab-lifted={props.lifted ? '' : undefined}
      data-plan-tab-draggable={props.draggable ? '' : undefined}
      onPointerDown={props.draggable ? (event) => props.onPointerDown(entry, event) : undefined}
      onClick={() => props.onOpen(entry)}
      className={cn(
        'flex w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-panel text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        props.lifted && 'opacity-40',
      )}
    >
      <span className={cn('block h-16 w-full shrink-0 overflow-hidden', look.soft)}>
        {cover !== null ? (
          <Thumbnail
            assetVersionId={cover}
            cache={sharedCardPresignCache()}
            presignEnabled={PRESIGN_ENABLED}
            fallback={{ kind: 'glyph' }}
            alt=""
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-1 p-2">
        <span className="line-clamp-2 text-[13px] font-semibold leading-[18px] text-fg [overflow-wrap:anywhere]">
          {entry.title}
        </span>
        {entry.kind === 'item' ? (
          <span className="flex min-w-0 items-start gap-1.5 text-[11px] leading-4 text-fg-2">
            <span aria-hidden="true" className={cn('mt-1 h-2 w-2 shrink-0', look.dot)} />
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{entry.bundle.plan.title}</span>
          </span>
        ) : null}
        {pill !== null ? (
          <span
            data-plan-tab-pill={pill.tone}
            className={cn(
              'inline-flex h-5 max-w-full items-center self-start truncate rounded-full px-2 text-[11px] font-semibold leading-5',
              PILL_TONES[pill.tone],
            )}
          >
            {pill.label}
          </span>
        ) : null}
        <span className="truncate text-[11px] leading-4 text-fg-3">
          {entry.kind === 'item'
            ? postStageLine(entry.bundle, entry.item)
            : `Post: ${entry.post.stage}`}
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

/** The lifted entry following the pointer (no pointer events of its own). */
function LiftedEntry(props: { drag: Drag }): ReactElement {
  const { drag } = props;
  const look = entryLook(drag.entry);
  return (
    <div
      data-plan-tab-drag-card=""
      aria-hidden="true"
      style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.width }}
      className="pointer-events-none fixed z-50 h-[26px] overflow-hidden rounded-md bg-panel shadow-2xl ring-1 ring-border-strong"
    >
      <span className={cn('flex h-full items-center gap-1.5 px-2 text-xs text-fg', look.soft)}>
        <span className={cn('h-2 w-2 shrink-0', look.dot)} />
        <span className="truncate">{drag.entry.title}</span>
      </span>
    </div>
  );
}

/**
 * The pointer drag: a press on an entry lifts it after DRAG_SLOP_PX of travel;
 * the day under the pointer is the drop target when the entry may go there;
 * release drops it there (and swallows the click that follows); Escape
 * cancels. Mouse and pen only (no touch drag).
 */
function useEntryDrag(input: {
  enabled: boolean;
  onDrop: (entry: CalendarEntry, day: string) => void;
}): {
  state: Drag | null;
  press: (entry: CalendarEntry, event: ReactPointerEvent<HTMLElement>) => void;
  consumeClick: () => boolean;
} {
  const [state, setState] = useState<Drag | null>(null);
  const stateRef = useRef<Drag | null>(null);
  const swallow = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const onDropRef = useRef(input.onDrop);
  onDropRef.current = input.onDrop;

  const set = (next: Drag | null): void => {
    stateRef.current = next;
    setState(next);
  };

  useEffect(() => () => cleanup.current?.(), []);

  const press = (entry: CalendarEntry, event: ReactPointerEvent<HTMLElement>): void => {
    if (!input.enabled || event.button !== 0 || event.pointerType === 'touch') return;
    cleanup.current?.();
    const rect = event.currentTarget.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (e: PointerEvent): void => {
      const lifted = stateRef.current;
      if (lifted === null) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP_PX) return;
      }
      e.preventDefault();
      const day = dayAt(e.clientX, e.clientY);
      set({
        entry,
        x: e.clientX,
        y: e.clientY,
        offX: startX - rect.left,
        offY: Math.min(startY - rect.top, 13),
        width: Math.min(rect.width, 220),
        over: day !== null && canDropOn(entry, day) ? day : null,
      });
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cleanup.current = null;
    };
    const up = (): void => {
      const lifted = stateRef.current;
      end();
      if (lifted === null) return;
      swallow.current = true;
      // The click that follows this release (if any) lands first; then it clears.
      window.setTimeout(() => {
        swallow.current = false;
      }, 0);
      set(null);
      if (lifted.over !== null) onDropRef.current(lifted.entry, lifted.over);
    };
    const cancel = (): void => {
      end();
      set(null);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || stateRef.current === null) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    cleanup.current = end;
  };

  const consumeClick = (): boolean => swallow.current;

  return { state, press, consumeClick };
}
