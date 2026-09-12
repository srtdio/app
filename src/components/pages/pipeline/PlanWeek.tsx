import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import {
  IconCalendar,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from '@/components/ui/icons';
import { PostCard } from '@/components/pages/PostCard';
import { BOARD_CAP, StageDot } from '@/components/pages/pipeline/stage-meta';
import { cn } from '@/lib/cn';
import {
  civilToday,
  formatCivilShort,
  groupByCivilDay,
  sortByUrgency,
  weekBounds,
  weekdayName,
} from '@/lib/plan-week';
import type { PresignCache } from '@/lib/asset-presign';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';

/** The canonical stage order, the same source the chip row reads. */
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

/** The only stage that clears the past-date marker. */
const APPROVED: Stage = 'approved';

export interface PlanWeekProps {
  /** The already filtered + sorted board list; Plan groups it, never refetches. */
  posts: PipelinePost[];
  /** The workspace IANA zone; the week is read in it, never in the browser's. */
  timeZone: string;
  /** The workspace week start, 0=Sun..6=Sat. */
  weekStartDay: number;
  /** Whole weeks from the current one; the page owns the state, Plan never stores it. */
  offset: number;
  onOffsetChange: (offset: number) => void;
  /** md and up renders the seven-column row; below it, stacked day sections. */
  isDesktop: boolean;
  /** One shared presign cache for the whole surface; never per-day or per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey?: string | null;
  /** Agency side only: shows the per-tile calendar button. Clients never see it. */
  canSetDate?: boolean;
  /** Opens the page's set-date sheet for a tile. */
  onSetDate?: (post: PipelinePost) => void;
  /** Opens the page's create sheet with a day prefilled ('YYYY-MM-DD'). */
  onAddOnDay?: (civil: string) => void;
  /** True while any sheet is open; the keyboard arrows stand down. */
  sheetOpen?: boolean;
}

const UNDATED_EMPTY = 'Every post has a date.';
const WEEK_EMPTY = 'Nothing dated this week. Set a target date on a post to see it here.';
const DAY_ADD = 'Add post';

/** Everything a tile needs beyond its post; one object instead of six params. */
interface TileContext {
  cache: PresignCache;
  presignEnabled: boolean;
  workspaceKey: string | null;
  canSetDate: boolean;
  onSetDate: (post: PipelinePost) => void;
  /** The tile's day is before today, so a non-approved post is late. */
  past: boolean;
}

/**
 * One tile. A plain helper (not a component) so each PostCard is inlined into
 * the returned tree and walkable by the structure tests, mirroring PipelineFeed.
 * Plan stays read-only apart from the calendar button, which only opens the
 * page's sheet: no drag handle, no long-press, no move sheet. PostCard itself is
 * never modified - the button and the past marker are absolutely positioned in
 * this wrapper, above the card's own link.
 */
function tile(post: PipelinePost, ctx: TileContext, className?: string): ReactElement {
  const late = ctx.past && post.stage !== APPROVED;
  return (
    <div key={post.id} data-post-id={post.id} className={cn('relative rounded-lg', className)}>
      <PostCard
        post={post}
        cache={ctx.cache}
        presignEnabled={ctx.presignEnabled}
        workspaceKey={ctx.workspaceKey}
      />
      {ctx.canSetDate ? (
        <button
          type="button"
          data-plan-set-date={post.id}
          aria-label="Set target date"
          onClick={() => ctx.onSetDate(post)}
          className={cn(
            'absolute right-0 top-0 z-10 flex h-11 w-11 items-center justify-center rounded-lg',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            post.target_date === null ? 'text-accent' : 'text-fg-2',
          )}
        >
          <IconCalendar size={16} />
        </button>
      ) : null}
      {late ? (
        <span data-plan-past-marker className="absolute bottom-1 right-1 z-10">
          <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-bad" />
          <span className="sr-only">Past date, not approved</span>
        </span>
      ) : null}
    </div>
  );
}

/** The 2-column tile grid the mobile feed uses, reused for days and undated. */
function tileGrid(posts: PipelinePost[], ctx: TileContext): ReactElement {
  return <div className="grid grid-cols-2 gap-2">{posts.map((post) => tile(post, ctx))}</div>;
}

/** The minimum of a keyboard event this surface reads; keeps the handler pure. */
export interface PlanKeyEvent {
  key: string;
  target: EventTarget | null;
}

/**
 * True when the event came from somewhere the user is typing, so the week arrows
 * must not steal the key. Duck-typed (no `instanceof HTMLElement`) so it is unit
 * testable without a DOM and safe under SSR.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export interface PlanKeyDeps {
  isDesktop: boolean;
  /** Any open sheet freezes the arrows: the sheet owns the keyboard. */
  sheetOpen: boolean;
  offset: number;
  onOffsetChange: (offset: number) => void;
}

/**
 * The desktop ArrowLeft/ArrowRight week stepper, as a pure handler so every gate
 * (desktop only, no open sheet, not while typing) is unit tested without a DOM.
 * Anything else is ignored, so no other key is ever swallowed.
 */
export function planKeyHandler(deps: PlanKeyDeps): (event: PlanKeyEvent) => void {
  return (event: PlanKeyEvent): void => {
    if (!deps.isDesktop || deps.sheetOpen) return;
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (step === 0) return;
    if (isTypingTarget(event.target)) return;
    deps.onOffsetChange(deps.offset + step);
  };
}

/**
 * The Plan surface: a week grouping of the Pipeline list by target date. The
 * arrows own the week (the page's date-window filter is deliberately NOT applied
 * upstream), the workspace zone and week start own the day boundaries, and the
 * posts are the ones already loaded by the page: no extra fetch and no N+1. The
 * only writes it can start are the page's two sheets (set a date, create a post
 * on a day); it never calls a proc itself. Motion law: switching weeks is an
 * instant re-render, the chevron rotation is a static transform, and the only
 * scrolling is the native X axis on desktop.
 */
export function PlanWeek({
  posts,
  timeZone,
  weekStartDay,
  offset,
  onOffsetChange,
  isDesktop,
  cache,
  presignEnabled,
  workspaceKey = null,
  canSetDate = false,
  onSetDate = () => {},
  onAddOnDay = () => {},
  sheetOpen = false,
}: PlanWeekProps): ReactElement {
  // The undated block's reveal depth, same in-place Show more pattern as the
  // feed. Week-independent, so switching weeks never resets it.
  const [shown, setShown] = useState(BOARD_CAP);
  // The undated block is collapsed on mount and re-collapsed on every week
  // change: the week is the subject of this surface, the undated pile is not.
  const [undatedOpen, setUndatedOpen] = useState(false);
  const todayRef = useRef<HTMLDivElement>(null);

  const bounds = useMemo(
    () => weekBounds({ now: new Date(), timeZone, weekStartDay, offset }),
    [timeZone, weekStartDay, offset],
  );
  const today = useMemo(() => civilToday(new Date(), timeZone), [timeZone]);
  const { byDay, undated } = useMemo(
    () => groupByCivilDay(posts, bounds.days, timeZone),
    [posts, bounds.days, timeZone],
  );
  // The undated pile is ordered by urgency (approved first): those are the posts
  // most in need of a date. The week columns keep the page's sort untouched.
  const undatedByUrgency = useMemo(() => sortByUrgency(undated), [undated]);

  useEffect(() => {
    setUndatedOpen(false);
  }, [offset]);

  // Bring today's column into view on mount and on every week switch back to
  // this week. Native, instant, X-axis only. Guarded with a typeof check so a
  // renderer without the DOM method (jsdom, SSR) never throws.
  useEffect(() => {
    if (!isDesktop || offset !== 0) return;
    const node = todayRef.current;
    if (node === null || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }, [isDesktop, offset, bounds.start]);

  // Desktop keyboard: left/right step the week. Gated by planKeyHandler (desktop
  // only, no open sheet, never while typing) and removed on cleanup.
  useEffect(() => {
    if (!isDesktop) return;
    const handle = planKeyHandler({ isDesktop, sheetOpen, offset, onOffsetChange });
    function onKeyDown(event: KeyboardEvent): void {
      handle(event);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isDesktop, sheetOpen, offset, onOffsetChange]);

  const weekEmpty = bounds.days.every((day) => (byDay[day] ?? []).length === 0);
  const undatedView = undatedByUrgency.slice(0, shown);
  const undatedApproved = undated.filter((post) => post.stage === APPROVED).length;

  /** Tile context for a day column; `past` drives the late marker. */
  function ctxFor(past: boolean): TileContext {
    return { cache, presignEnabled, workspaceKey, canSetDate, onSetDate, past };
  }
  // Undated posts have no day at all, so they are never late.
  const undatedCtx = ctxFor(false);

  const header = (
    <div className="flex items-center gap-2 px-4 pt-4 md:px-6">
      <Button
        variant="ghost"
        size="lg"
        aria-label="Previous week"
        className="w-11 px-0"
        onClick={() => onOffsetChange(offset - 1)}
      >
        <IconChevronLeft size={18} />
      </Button>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{bounds.label}</span>
        <span className="text-xs tabular-nums text-fg-3">
          {formatCivilShort(bounds.start)} to {formatCivilShort(bounds.end)}
        </span>
      </div>
      <Button
        variant="ghost"
        size="lg"
        aria-label="Next week"
        className="w-11 px-0"
        onClick={() => onOffsetChange(offset + 1)}
      >
        <IconChevronRight size={18} />
      </Button>
      {offset !== 0 ? (
        <Button variant="default" size="lg" className="ml-auto" onClick={() => onOffsetChange(0)}>
          Today
        </Button>
      ) : null}
    </div>
  );

  const undatedBlock = (
    <section data-plan-undated className="px-4 pt-4 md:px-6">
      <button
        type="button"
        data-plan-undated-toggle
        aria-expanded={undatedOpen}
        onClick={() => setUndatedOpen((openNow) => !openNow)}
        className="flex h-11 w-full items-center gap-2 rounded-lg px-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="text-sm font-medium">Undated</span>
        <span className="text-xs tabular-nums text-fg-3">{undated.length}</span>
        <span className="ml-auto text-xs tabular-nums text-fg-3">{undatedApproved} approved</span>
        <IconChevronDown
          size={16}
          className={cn('text-fg-3', undatedOpen ? 'rotate-180' : undefined)}
        />
      </button>
      {!undatedOpen ? null : undated.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel-2 px-3 py-4 text-sm text-fg-3">
          {UNDATED_EMPTY}
        </div>
      ) : (
        <>
          {isDesktop ? (
            <div className="flex gap-2 overflow-x-auto overflow-y-hidden pb-1">
              {undatedView.map((post) => tile(post, undatedCtx, 'w-[180px] shrink-0'))}
            </div>
          ) : (
            tileGrid(undatedView, undatedCtx)
          )}
          {undated.length > shown ? (
            <div className="mt-3 flex justify-center">
              <Button variant="default" size="lg" onClick={() => setShown((s) => s + BOARD_CAP)}>
                Show {Math.min(BOARD_CAP, undated.length - shown)} more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );

  function dayHeading(day: string, index: number, count: number): ReactElement {
    const isToday = day === today;
    // Civil date strings compare lexicographically, so this is a plain string
    // compare in the workspace zone: no instant is built to answer it.
    const isPast = day < today;
    const tone = isToday ? 'text-accent' : isPast ? 'text-fg-3' : undefined;
    return (
      <>
        <span data-plan-day-name className={cn('text-sm font-medium', tone)}>
          {weekdayName(weekStartDay, index)}
        </span>{' '}
        <span data-plan-day-number className={cn('text-sm tabular-nums', tone ?? 'text-fg-2')}>
          {formatCivilShort(day)}
        </span>
        <span data-plan-day-count className="ml-auto text-xs tabular-nums text-fg-3">
          {count}
        </span>
      </>
    );
  }

  /** The distinct stages present on a day, in the canonical chip-row order. */
  function dayStages(list: PipelinePost[]): Stage[] {
    return STAGES.filter((stage) => list.some((post) => post.stage === stage));
  }

  function addButton(day: string, className: string): ReactElement {
    return (
      <button
        type="button"
        data-plan-day-empty
        data-plan-day-add={day}
        onClick={() => onAddOnDay(day)}
        className={cn(
          'flex w-full items-center justify-center gap-2 text-sm text-fg-3',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          className,
        )}
      >
        <IconPlus size={16} />
        {DAY_ADD}
      </button>
    );
  }

  const week = isDesktop ? (
    // X axis only: the page owns vertical scrolling, exactly as the board does.
    <div
      data-plan-scroll
      className="flex min-h-0 gap-3 overflow-x-auto overflow-y-hidden px-4 py-4 md:px-6"
    >
      {bounds.days.map((day, index) => {
        const list = byDay[day] ?? [];
        const ctx = ctxFor(day < today);
        return (
          <div
            key={day}
            data-plan-day={day}
            ref={day === today ? todayRef : undefined}
            className={cn(
              'flex w-[260px] shrink-0 flex-col rounded-xl border bg-panel-2',
              day === today ? 'border-accent-line' : 'border-border',
            )}
          >
            <div className="flex h-11 items-center gap-2 border-b border-border px-3">
              {dayHeading(day, index, list.length)}
            </div>
            {list.length > 0 ? (
              <div
                data-plan-day-stages={day}
                className="flex items-center gap-1 border-b border-border px-3 py-1.5"
              >
                {dayStages(list).map((stage) => (
                  <StageDot key={stage} stage={stage} />
                ))}
              </div>
            ) : null}
            {list.length === 0 ? (
              addButton(day, 'min-h-[160px] px-3 py-6')
            ) : (
              <div className="flex flex-col gap-2 p-2">{list.map((post) => tile(post, ctx))}</div>
            )}
          </div>
        );
      })}
    </div>
  ) : (
    <div className="flex flex-col gap-4 px-4 py-4">
      {bounds.days.map((day, index) => {
        const list = byDay[day] ?? [];
        const ctx = ctxFor(day < today);
        return (
          <section key={day} data-plan-day={day}>
            <div className="flex h-11 items-center gap-2">
              {dayHeading(day, index, list.length)}
            </div>
            {list.length === 0
              ? addButton(day, 'min-h-[44px] rounded-lg border border-dashed border-border')
              : tileGrid(list, ctx)}
          </section>
        );
      })}
    </div>
  );

  return (
    <>
      {header}
      {weekEmpty && undated.length === 0 ? (
        <div data-plan-empty className="px-4 py-10 text-sm text-fg-3 md:px-6">
          {WEEK_EMPTY}
        </div>
      ) : (
        <>
          {undatedBlock}
          {week}
        </>
      )}
    </>
  );
}
