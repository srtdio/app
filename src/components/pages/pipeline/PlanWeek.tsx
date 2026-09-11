import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import { PostCard } from '@/components/pages/PostCard';
import { BOARD_CAP } from '@/components/pages/pipeline/stage-meta';
import { cn } from '@/lib/cn';
import {
  civilToday,
  dayOfMonth,
  formatCivilShort,
  groupByCivilDay,
  weekBounds,
  weekdayName,
} from '@/lib/plan-week';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

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
}

const UNDATED_EMPTY = 'Every post has a date.';
const WEEK_EMPTY = 'Nothing dated this week. Set a target date on a post to see it here.';
const DAY_EMPTY = 'Nothing dated';

/**
 * One tile. A plain helper (not a component) so each PostCard is inlined into
 * the returned tree and walkable by the structure tests, mirroring PipelineFeed.
 * Plan is read-only: no drag handle, no long-press, no move sheet. PostCard's
 * own tap navigation is the only interaction.
 */
function tile(
  post: PipelinePost,
  cache: PresignCache,
  presignEnabled: boolean,
  workspaceKey: string | null,
  className?: string,
): ReactElement {
  return (
    <div key={post.id} data-post-id={post.id} className={cn('rounded-lg', className)}>
      <PostCard
        post={post}
        cache={cache}
        presignEnabled={presignEnabled}
        workspaceKey={workspaceKey}
      />
    </div>
  );
}

/** The 2-column tile grid the mobile feed uses, reused for days and undated. */
function tileGrid(
  posts: PipelinePost[],
  cache: PresignCache,
  presignEnabled: boolean,
  workspaceKey: string | null,
): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2">
      {posts.map((post) => tile(post, cache, presignEnabled, workspaceKey))}
    </div>
  );
}

/**
 * The Plan surface: a read-only week grouping of the Pipeline list by target
 * date. No writes, no scheduling, no drag. The arrows own the week (the page's
 * date-window filter is deliberately NOT applied upstream), the workspace zone
 * and week start own the day boundaries, and the posts are the ones already
 * loaded by the page: no extra fetch and no N+1. Motion law: switching weeks is
 * an instant re-render; the only scrolling is the native X axis on desktop.
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
}: PlanWeekProps): ReactElement {
  // The undated block's reveal depth, same in-place Show more pattern as the
  // feed. Week-independent, so switching weeks never resets it.
  const [shown, setShown] = useState(BOARD_CAP);
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

  // Bring today's column into view on mount and on every week switch back to
  // this week. Native, instant, X-axis only. Guarded with a typeof check so a
  // renderer without the DOM method (jsdom, SSR) never throws.
  useEffect(() => {
    if (!isDesktop || offset !== 0) return;
    const node = todayRef.current;
    if (node === null || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }, [isDesktop, offset, bounds.start]);

  const weekEmpty = bounds.days.every((day) => (byDay[day] ?? []).length === 0);
  const undatedView = undated.slice(0, shown);

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
      <div className="flex h-11 items-center gap-2">
        <span className="text-sm font-medium">Undated</span>
        <span className="text-xs tabular-nums text-fg-3">{undated.length}</span>
        <span className="ml-auto text-xs text-fg-3">no target date yet</span>
      </div>
      {undated.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel-2 px-3 py-4 text-sm text-fg-3">
          {UNDATED_EMPTY}
        </div>
      ) : (
        <>
          {isDesktop ? (
            <div className="flex gap-2 overflow-x-auto overflow-y-hidden pb-1">
              {undatedView.map((post) =>
                tile(post, cache, presignEnabled, workspaceKey, 'w-[180px] shrink-0'),
              )}
            </div>
          ) : (
            tileGrid(undatedView, cache, presignEnabled, workspaceKey)
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
    return (
      <>
        <span
          data-plan-day-name
          className={cn('text-sm font-medium', isToday ? 'text-accent' : undefined)}
        >
          {weekdayName(weekStartDay, index)}
        </span>
        <span
          data-plan-day-number
          className={cn('text-sm tabular-nums', isToday ? 'text-accent' : 'text-fg-2')}
        >
          {dayOfMonth(day)}
        </span>
        <span data-plan-day-count className="ml-auto text-xs tabular-nums text-fg-3">
          {count}
        </span>
      </>
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
            {list.length === 0 ? (
              <div className="flex min-h-[160px] items-center justify-center px-3 py-6 text-sm text-fg-3">
                {DAY_EMPTY}
              </div>
            ) : (
              <div className="flex flex-col gap-2 p-2">
                {list.map((post) => tile(post, cache, presignEnabled, workspaceKey))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  ) : (
    <div className="flex flex-col gap-4 px-4 py-4">
      {bounds.days.map((day, index) => {
        const list = byDay[day] ?? [];
        return (
          <section key={day} data-plan-day={day}>
            <div className="flex h-11 items-center gap-2">
              {dayHeading(day, index, list.length)}
            </div>
            {list.length === 0 ? (
              <div
                aria-hidden
                className="h-9 rounded-lg border border-dashed border-border"
                data-plan-day-empty
              />
            ) : (
              tileGrid(list, cache, presignEnabled, workspaceKey)
            )}
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
