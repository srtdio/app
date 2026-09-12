import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconCheck, IconPlus, IconX } from '@/components/ui/icons';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { PlanWeek } from '@/components/pages/pipeline/PlanWeek';
import { StageChips } from '@/components/pages/pipeline/StageChips';
import type { StageChipItem } from '@/components/pages/pipeline/StageChips';
import { PipelineSortControl } from '@/components/pages/pipeline/PipelineSortControl';
import { MoveSheet } from '@/components/pages/pipeline/MoveSheet';
import { SetDateSheet } from '@/components/pages/pipeline/SetDateSheet';
import { BOARD_CAP, stageLabel } from '@/components/pages/pipeline/stage-meta';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { dispatchSorted } from '@/lib/events';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useMediaQuery } from '@/lib/use-media-query';
import { useSort } from '@/lib/use-sort';
import { useSession } from '@/lib/session-context';
import { useNewTrace } from '@/lib/trace-context';
import { fetchMemberRole } from '@/lib/assets';
import { isAgencySide } from '@/components/pages/pcs/roles';
import {
  DATE_WINDOW_DEFAULT,
  POST_SORT_DEFAULT,
  POST_SORT_OPTIONS,
  filterByFields,
  filterByWindow,
  sortPosts,
  type DateWindow,
  type PostSort,
} from '@/lib/list-sort';

interface DateRange {
  start: string;
  end: string;
}
import { groupByStage, stageColumns } from '@/lib/post-board';
import { useWorkspaceMembers } from '@/components/chat/use-workspace-members';
import { listPosts, postUpdate, STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type {
  Client,
  DomainErrorCode,
  PipelinePost,
  PostUpdateInput,
  Result,
  Stage,
} from '@srtdio/posts';
import { PresignCache } from '@/lib/asset-presign';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import {
  civilNoonInZoneIso,
  groupByCivilDay,
  weekBounds,
  PLAN_WEEK_DAYS,
  type DayGrouping,
} from '@/lib/plan-week';
import { addCivilDays } from '@/lib/list-sort';

// The board columns are the workflow stages, in transition-map order. Stage
// values come from the @srtdio/posts type, never hardcoded literals in JSX.
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

/**
 * The two UI-only chip keys. Neither is a workflow stage: PLAN_KEY switches the
 * surface to the read-only week view (and clears the stage filter, so Plan shows
 * every stage), ALL_KEY is the existing unfiltered board.
 */
export const PLAN_KEY = 'plan';
const ALL_KEY = 'all';

// The app's md breakpoint: kanban at >=768px, the stacked tab feed below it.
const DESKTOP_QUERY = '(min-width: 768px)';

interface PipelineHeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  sort: PostSort;
  onSortChange: (value: PostSort) => void;
  /** Target-date window state, folded into the consolidated sort control. */
  dateWindow: DateWindow;
  onDateWindowChange: (value: DateWindow) => void;
  customRange: DateRange | null;
  onCustomRangeChange: (range: DateRange | null) => void;
  weekStartDay: number;
  stage: string;
  onStageChange: (key: string) => void;
  /** Per-tab post counts keyed by tab ('all' plus each Stage), shown as badges. */
  counts: Record<string, number>;
}

/**
 * The Pipeline header chrome: the shared SectionHeader (search, sort, accent "+"
 * create) with the horizontal stage chip bar in the filter-chips slot. Each chip
 * carries its label and post count as discrete fields (StageChips renders the
 * count as a trailing badge). Pure (no hooks) so the wiring is unit-tested by
 * walking the returned tree, mirroring SectionHeader's own tests; the page owns
 * the state and re-fetch.
 */
export function pipelineHeader(props: PipelineHeaderProps): ReactElement {
  // Plan leads the row (no dot, no count: it is a surface switch, not a stage
  // filter), the five stages keep their transition-map order, All closes it.
  const items: StageChipItem[] = [
    { key: PLAN_KEY, label: 'Plan' },
    ...STAGES.map((stage) => ({
      key: stage,
      label: stageLabel(stage),
      count: props.counts[stage] ?? 0,
      stage,
    })),
    { key: ALL_KEY, label: 'All', count: props.counts.all ?? 0 },
  ];
  return (
    <SectionHeader<PostSort>
      search={{ value: props.search, onChange: props.onSearchChange, placeholder: 'Search posts' }}
      sort={{
        node: (
          <PipelineSortControl
            order={props.sort}
            onOrderChange={props.onSortChange}
            dateWindow={props.dateWindow}
            onDateWindowChange={props.onDateWindowChange}
            customRange={props.customRange}
            onCustomRangeChange={props.onCustomRangeChange}
            weekStartDay={props.weekStartDay}
          />
        ),
      }}
      primaryAction={{
        node: (
          <Button
            variant="primary"
            size="lg"
            aria-label="Create post"
            className="w-11 px-0"
            onClick={() => dispatchSorted('sorted:create-post')}
          >
            <IconPlus size={18} />
          </Button>
        ),
      }}
    >
      <StageChips items={items} active={props.stage} onChange={props.onStageChange} />
    </SectionHeader>
  );
}

/**
 * Friendly copy for an unmapped domain code OR a transport-level throw (network /
 * RPC failure with no Result). Shared by {@link moveErrorMessage}'s default and the
 * catch in {@link runMovePost} so both paths surface the same retry line.
 */
export const MOVE_FALLBACK_MESSAGE = 'Could not move the post. Please try again.';

/**
 * Map a proc domain error to friendly copy. The raw codes (invalid_stage_transition,
 * forbidden_role, ...) never reach the user; an unmapped/transport error gets a
 * generic retry line.
 */
export function moveErrorMessage(code: DomainErrorCode): string {
  switch (code) {
    case 'invalid_stage_transition':
      return 'That move is not allowed from this stage.';
    case 'forbidden_role':
    case 'workspace_member_only':
      return 'You do not have permission to move this post.';
    default:
      return MOVE_FALLBACK_MESSAGE;
  }
}

/**
 * Per-tab counts over the ALREADY-FILTERED, grouped list: each stage's column
 * length plus an `all` that is the FILTERED TOTAL (the sum across stages), not the
 * raw unfiltered post count and not the per-stage display cap. Reused for both the
 * tab badges and the header "N posts" counter so the counter tracks the search.
 */
export function stageCounts(
  grouped: Record<Stage, PipelinePost[]>,
  stages: Stage[],
): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const s of stages) {
    out[s] = grouped[s].length;
    total += grouped[s].length;
  }
  out.all = total;
  return out;
}

/** The header counter label, driven by the filtered total from {@link stageCounts}. */
export function postCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'post' : 'posts'}`;
}

/** The searchable fields of a post; one source for both list derivations. */
function postSearchFields(post: PipelinePost): (string | null)[] {
  return [post.title, post.caption, post.platform];
}

/**
 * The Plan list: the same search and sort every other surface applies, and
 * nothing else. The target-date window (and its custom range) is deliberately
 * NOT applied here: in Plan the week arrows own the date range, so a window left
 * on 'This week' must never hide a post from the week the arrows are pointing
 * at. Pure and derived over the in-memory list: no refetch, no N+1.
 */
export function planList(posts: PipelinePost[], search: string, sort: PostSort): PipelinePost[] {
  return sortPosts(filterByFields(posts, search, postSearchFields), sort);
}

/**
 * The Plan header counter: every post shown on the surface, which is the week's
 * dated posts plus ALL the undated ones (the undated block's cap is a display
 * depth, not a filter).
 */
export function planCount(grouping: DayGrouping<PipelinePost>, days: string[]): number {
  const dated = days.reduce((total, day) => total + (grouping.byDay[day]?.length ?? 0), 0);
  return dated + grouping.undated.length;
}

/** Everything {@link pipelineSurface} needs to pick and wire the active surface. */
export interface PipelineSurfaceProps {
  /** The active chip: PLAN_KEY, ALL_KEY, or a Stage. */
  stage: string;
  isDesktop: boolean;
  /** Search + window + sort; the board and feed list. */
  sorted: PipelinePost[];
  /** Search + sort only; the Plan list (see {@link planList}). */
  planPosts: PipelinePost[];
  grouped: Record<Stage, PipelinePost[]>;
  timeZone: string;
  weekStartDay: number;
  weekOffset: number;
  onWeekOffsetChange: (offset: number) => void;
  /** Agency side only: Plan renders the per-tile set-date button. */
  canSetDate: boolean;
  onSetDate: (post: PipelinePost) => void;
  onAddOnDay: (civil: string) => void;
  /** True while any sheet is open; Plan's keyboard arrows stand down. */
  sheetOpen: boolean;
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey: string | null;
  onViewAll: (stage: Stage) => void;
  onMovePost: (postId: string, toStage: Stage) => void;
  onLongPressPost: (post: PipelinePost) => void;
}

/**
 * Pick the body surface for the active chip: the read-only Plan week, the
 * desktop kanban, or the mobile feed. Pure (no hooks; the components it returns
 * own their own state) so the branch is unit-tested by walking the element.
 */
export function pipelineSurface(props: PipelineSurfaceProps): ReactElement {
  if (props.stage === PLAN_KEY) {
    return (
      <PlanWeek
        posts={props.planPosts}
        timeZone={props.timeZone}
        weekStartDay={props.weekStartDay}
        offset={props.weekOffset}
        onOffsetChange={props.onWeekOffsetChange}
        isDesktop={props.isDesktop}
        cache={props.cache}
        presignEnabled={props.presignEnabled}
        workspaceKey={props.workspaceKey}
        canSetDate={props.canSetDate}
        onSetDate={props.onSetDate}
        onAddOnDay={props.onAddOnDay}
        sheetOpen={props.sheetOpen}
      />
    );
  }
  if (props.isDesktop) {
    return (
      <PipelineBoard
        stages={stageColumns(STAGES, props.stage)}
        grouped={props.grouped}
        cap={props.stage === ALL_KEY ? BOARD_CAP : null}
        cache={props.cache}
        presignEnabled={props.presignEnabled}
        workspaceKey={props.workspaceKey}
        onViewAll={props.onViewAll}
        onMovePost={props.onMovePost}
      />
    );
  }
  return (
    <PipelineFeed
      posts={props.sorted}
      activeStage={props.stage}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      workspaceKey={props.workspaceKey}
      onLongPressPost={props.onLongPressPost}
    />
  );
}

/**
 * Heal a persisted sort the trimmed menu no longer lists. Live workspaces stored
 * 'newest'/'oldest'/'title' from the old five-option menu; those map back to the
 * default. A value the menu still lists passes through. The store itself is left
 * untouched, so the first user pick (onSortChange = setSort) overwrites it.
 */
export function sanitizePostSort(sort: string): PostSort {
  return POST_SORT_OPTIONS.some((o) => o.value === sort) ? (sort as PostSort) : POST_SORT_DEFAULT;
}

/** The two URL params this surface owns: which view, and which week. */
const VIEW_PARAM = 'view';
const WEEK_PARAM = 'week';

/** A civil date, shape only; {@link civilDayMs} re-checks that it is a real day. */
const CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A civil date as UTC midnight ms, or null when it is not a real calendar day. */
function civilDayMs(civil: string): number | null {
  // addCivilDays normalizes (2026-02-31 -> 2026-03-03), so a value that survives
  // a zero-day step unchanged is a real date, not just a well-shaped string.
  if (!CIVIL_RE.test(civil) || addCivilDays(civil, 0) !== civil) return null;
  const [year, month, day] = civil.split('-').map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) return null;
  return Date.UTC(year, month - 1, day);
}

/**
 * The stage chip the page opens on, read from the URL: `?view=plan` restores the
 * Plan surface, anything else (including a missing or unknown value) keeps the
 * Review default. Only the surface is restored from the URL; the stage filter
 * itself is never a param.
 */
export function initialStage(params: URLSearchParams): string {
  return params.get(VIEW_PARAM) === PLAN_KEY ? PLAN_KEY : 'review';
}

/**
 * The week offset a `?week=YYYY-MM-DD` param means, relative to the current
 * week. An absent, malformed, impossible, or non-week-aligned value is ignored
 * (offset 0) rather than throwing or landing the user on a half week.
 */
export function weekOffsetFromParam(
  week: string | null,
  opts: { now: Date; timeZone: string; weekStartDay: number },
): number {
  if (week === null) return 0;
  const picked = civilDayMs(week);
  if (picked === null) return 0;
  const current = civilDayMs(weekBounds({ ...opts, offset: 0 }).start);
  if (current === null) return 0;
  const days = Math.round((picked - current) / 86400000);
  return days % PLAN_WEEK_DAYS === 0 ? days / PLAN_WEEK_DAYS : 0;
}

/**
 * The next search params for a surface change: `view=plan` only on Plan, `week`
 * only on a non-zero offset, and every other param on the URL left untouched.
 * Pure (a new URLSearchParams), so the page can hand it straight to
 * setSearchParams with `replace` and the arrows never pollute history.
 */
export function planParams(
  current: URLSearchParams,
  next: { stage: string; weekStart: string | null },
): URLSearchParams {
  const params = new URLSearchParams(current);
  if (next.stage === PLAN_KEY) params.set(VIEW_PARAM, PLAN_KEY);
  else params.delete(VIEW_PARAM);
  if (next.stage === PLAN_KEY && next.weekStart !== null) params.set(WEEK_PARAM, next.weekStart);
  else params.delete(WEEK_PARAM);
  return params;
}

/** Everything {@link runSetTargetDate} needs; the page wires it, tests drive it. */
export interface SetTargetDateDeps {
  client: Client;
  postId: string;
  /** The workspace zone the picked civil day is anchored in. */
  timeZone: string;
  newTrace: () => string;
  /** Injected so the test drives the write without mocking the module. */
  postUpdate: (client: Client, input: PostUpdateInput, traceId?: string) => Promise<Result<string>>;
  /** Closes the sheet; only called on success. */
  onClose: () => void;
  /** Re-reads the board; one call, so dating a post is never an N+1. */
  reload: () => Promise<void>;
  toast: (message: string) => void;
}

/** The single retry line for a failed target-date write. */
export const SET_DATE_FALLBACK_MESSAGE = 'Could not save the change. Please try again.';

/**
 * Write a post's target date from Plan. A picked civil day is stored as the
 * instant that is NOON IN THE WORKSPACE ZONE, so the post groups back onto the
 * day the user tapped in every zone (negative offsets and DST included); null
 * clears the column. On failure the sheet stays open and a friendly line is
 * toasted; on success the sheet closes and the board reloads once.
 */
export async function runSetTargetDate(
  deps: SetTargetDateDeps,
  civil: string | null,
): Promise<void> {
  const targetDate = civil === null ? null : civilNoonInZoneIso(civil, deps.timeZone);
  try {
    const result = await deps.postUpdate(
      deps.client,
      { postId: deps.postId, targetDate },
      deps.newTrace(),
    );
    if (!result.ok) {
      deps.toast(SET_DATE_FALLBACK_MESSAGE);
      return;
    }
    deps.onClose();
    await deps.reload();
  } catch {
    // Transport-level failure (network / RPC throw, not a domain Result): the
    // sheet stays open with the same retry line, exactly as a domain error.
    deps.toast(SET_DATE_FALLBACK_MESSAGE);
  }
}

/** Everything {@link runMovePost} needs, so the page wires it and tests drive it directly. */
export interface MovePostDeps {
  client: Client;
  posts: PipelinePost[];
  /** In-flight post ids; the double-fire guard. Shared across calls (a ref's .current). */
  inFlight: Set<string>;
  setPosts: (updater: (prev: PipelinePost[]) => PipelinePost[]) => void;
  /** Close the move sheet (no-op on the desktop drag path). */
  onClose: () => void;
  toast: (message: string) => void;
}

/**
 * The single move handler: AWAIT the stage_transition proc, then on success flip
 * the post's local stage (the page's useMemo re-groups it into the new column /
 * section) and toast; on failure leave the post where it was and toast a friendly
 * error. A per-post in-flight guard drops a double fire (a slow network can't
 * double-submit). Command, not query: it mutates state and toasts, returns nothing.
 */
export async function runMovePost(
  deps: MovePostDeps,
  postId: string,
  toStage: Stage,
): Promise<void> {
  if (deps.inFlight.has(postId)) {
    return;
  }
  const target = deps.posts.find((post) => post.id === postId);
  if (target === undefined) {
    return;
  }
  deps.inFlight.add(postId);
  try {
    const result = await stageTransition(deps.client, { postId, toStage });
    if (!result.ok) {
      deps.toast(moveErrorMessage(result.error.code));
      return;
    }
    deps.setPosts((prev) =>
      prev.map((post) => (post.id === postId ? { ...post, stage: toStage } : post)),
    );
    deps.onClose();
    deps.toast(`"${target.title}" moved to ${stageLabel(toStage)}`);
  } catch {
    // Transport-level failure (network / RPC throw, not a domain Result): without
    // this the throw surfaced nothing to the user. No optimistic flip is applied
    // (the local stage update runs only after a successful proc), so the board is
    // already consistent and there is nothing to revert. The finally below still
    // clears the in-flight guard, exactly as on the success and domain-error paths.
    deps.toast(MOVE_FALLBACK_MESSAGE);
  } finally {
    deps.inFlight.delete(postId);
  }
}

interface OnboardingStep {
  key: string;
  label: string;
  action: string;
  run: () => void;
}

export function PipelinePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // The active surface, restored from ?view=plan on load (Review otherwise).
  const [stage, setStage] = useState(() => initialStage(searchParams));
  const [search, setSearch] = useState('');
  const { value: sort, setValue: setSort } = useSort<PostSort>('pipeline', POST_SORT_DEFAULT);
  // Sanitize the persisted sort: a live workspace may hold a value the trimmed
  // menu no longer lists ('newest'/'title'). Fall back to the default for the
  // derivation and the header, but leave setSort untouched so the first user pick
  // heals storage.
  const activeSort = sanitizePostSort(sort);
  // Target-date window: not persisted, resets to 'any' on load (the global
  // `window` is used below for addEventListener, so this is named dateWindow).
  const [dateWindow, setDateWindow] = useState<DateWindow>(DATE_WINDOW_DEFAULT);
  // The custom date range for the 'custom' window; in-memory only, defaults to
  // null (no range yet picked, so filterByWindow passes the list through).
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  // The active workspace's civil-date context for the window filter; the helper
  // re-validates the zone, so a bad stored value is still safe.
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId);
  const timeZone = activeWorkspace?.timezone ?? 'UTC';
  const weekStartDay = activeWorkspace?.week_start_day ?? 1;
  // Whole weeks from the current one on the Plan surface, DERIVED from ?week so
  // the URL is the single source of truth: a shared link opens the same week,
  // and the offset re-derives correctly once the workspace zone resolves. Never
  // persisted; an absent or unparseable param is this week.
  const weekOffset = useMemo(
    () =>
      weekOffsetFromParam(searchParams.get(WEEK_PARAM), {
        now: new Date(),
        timeZone,
        weekStartDay,
      }),
    [searchParams, timeZone, weekStartDay],
  );
  const [cardDismissed, setCardDismissed] = useState(false);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});

  const [posts, setPosts] = useState<PipelinePost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // The civil day the create sheet opens prefilled with (from an empty day in
  // Plan); null is the plain "+" create with no date.
  const [createTargetDate, setCreateTargetDate] = useState<string | null>(null);
  const [movePostTarget, setMovePostTarget] = useState<PipelinePost | null>(null);
  // The post whose target date is being set from Plan, and the in-flight flag
  // that disables the sheet while post_update runs.
  const [setDateTarget, setSetDateTarget] = useState<PipelinePost | null>(null);
  const [savingDate, setSavingDate] = useState(false);
  // Reactive mirror of the in-flight guard for the open move sheet: the guard
  // itself is a ref (no re-render), so this state drives the sheet's busy prop.
  const [movingId, setMovingId] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();
  const newTrace = useNewTrace();
  // The viewer's role, loaded once from the membership exactly as PCS does: only
  // the agency side may set a date from Plan, and an unknown role stays
  // read-only, so a client never sees the calendar button.
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const [role, setRole] = useState<string | null>(null);
  const agencySide = isAgencySide(role);
  // Per-post in-flight guard for the move handler (a ref so a re-render never
  // resets it mid-flight); shared by the desktop drop and mobile sheet paths.
  const inFlight = useRef<Set<string>>(new Set());

  // One presign cache for the whole board: it bounds concurrency and caches
  // URLs so every card shares a single cap, mirroring AssetsPage. Cards
  // lazy-resolve their own thumbnail via useInView; the page adds no fetches.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = useMemo(
    () =>
      new PresignCache({
        endpoint: env.VITE_ASSET_READ_URL ?? null,
        getAccessToken: async () =>
          (await supabase.auth.getSession()).data.session?.access_token ?? null,
        fetcher: (input, init) => fetchWithTrace(input, init),
      }),
    [],
  );

  // One fetch for the whole board (no N+1): listPosts once, grouped in memory.
  const loadPosts = useCallback(async () => {
    if (workspaceId === null) return;
    setPostsLoading(true);
    setPostsError(null);
    const result = await listPosts(supabase, { workspaceId, limit: 500 });
    setPostsLoading(false);
    if (!result.ok) {
      setPostsError(result.error.message);
      return;
    }
    setPosts(result.data);
  }, [workspaceId]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  useEffect(() => {
    if (workspaceId === null || userId === null) {
      setRole(null);
      return;
    }
    let cancelled = false;
    void fetchMemberRole(supabase, workspaceId, userId).then((next) => {
      if (!cancelled) setRole(next);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId]);

  // The Create (+) button and command palette dispatch this event; the sheet
  // lives here so the board can re-fetch on success.
  useEffect(() => {
    function openCreate(): void {
      // The generic "+" never carries a day; only an empty Plan day prefills one.
      setCreateTargetDate(null);
      setCreateOpen(true);
    }
    window.addEventListener('sorted:create-post', openCreate);
    return () => {
      window.removeEventListener('sorted:create-post', openCreate);
    };
  }, []);

  // Search + sort are pure, derived over the in-memory list (listPosts loads the
  // whole board), so no refetch and no N+1: filter by title + caption + platform,
  // then order, then group into columns. groupByStage is generic over the element
  // type, so it preserves PipelinePost (thumbnailAssetVersionId and all) with no
  // assertion.
  const sorted = useMemo(
    () =>
      sortPosts(
        filterByWindow(filterByFields(posts, search, postSearchFields), dateWindow, {
          now: new Date(),
          timeZone,
          weekStartDay,
          customRange,
        }),
        activeSort,
      ),
    [posts, search, dateWindow, customRange, activeSort, timeZone, weekStartDay],
  );
  const grouped = useMemo(() => groupByStage(sorted, STAGES), [sorted]);

  // Per-tab counts over the filtered list: each stage plus the 'all' total.
  const counts = useMemo(() => stageCounts(grouped, STAGES), [grouped]);

  // The Plan derivations: the same in-memory list, searched and sorted but NOT
  // date-windowed (the week arrows own the range there), grouped into the
  // workspace week. Pure and cheap, so no extra fetch and no N+1.
  const planPosts = useMemo(() => planList(posts, search, activeSort), [posts, search, activeSort]);
  const planBounds = useMemo(
    () => weekBounds({ now: new Date(), timeZone, weekStartDay, offset: weekOffset }),
    [timeZone, weekStartDay, weekOffset],
  );
  const planGrouped = useMemo(
    () => groupByCivilDay(planPosts, planBounds.days, timeZone),
    [planPosts, planBounds.days, timeZone],
  );
  const isPlan = stage === PLAN_KEY;
  // The header counter follows the active surface: the week + undated total in
  // Plan, the filtered board total everywhere else.
  const shownCount = isPlan ? planCount(planGrouped, planBounds.days) : (counts.all ?? 0);

  // Picking Plan clears the stage filter (Plan shows every stage) and always
  // lands on this week; picking any other chip simply leaves Plan. The URL
  // follows: ?view=plan on Plan, both params dropped everywhere else. replace,
  // never push, so switching surfaces never grows the back stack.
  const changeStage = useCallback(
    (key: string): void => {
      setStage(key);
      setSearchParams(planParams(searchParams, { stage: key, weekStart: null }), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // The week arrows write the week's start day into ?week (offset 0 drops it),
  // which is what the derived weekOffset above reads back. replace, not push, so
  // stepping through weeks never pollutes history.
  const changeWeekOffset = useCallback(
    (next: number): void => {
      const start = weekBounds({ now: new Date(), timeZone, weekStartDay, offset: next }).start;
      setSearchParams(
        planParams(searchParams, { stage: PLAN_KEY, weekStart: next === 0 ? null : start }),
        { replace: true },
      );
    },
    [searchParams, setSearchParams, timeZone, weekStartDay],
  );

  // Dating a post from Plan: one post_update, then one reload (never an N+1).
  const saveTargetDate = useCallback(
    (civil: string | null): void => {
      if (setDateTarget === null) return;
      setSavingDate(true);
      void runSetTargetDate(
        {
          client: supabase,
          postId: setDateTarget.id,
          timeZone,
          newTrace,
          postUpdate,
          onClose: () => setSetDateTarget(null),
          reload: loadPosts,
          toast: push,
        },
        civil,
      ).finally(() => setSavingDate(false));
    },
    [setDateTarget, timeZone, newTrace, loadPosts, push],
  );

  // An empty day in Plan opens the same create sheet the "+" opens, with that
  // day prefilled as the target date.
  const addOnDay = useCallback((civil: string): void => {
    setCreateTargetDate(civil);
    setCreateOpen(true);
  }, []);

  // Single source for the move: both the desktop drop and the mobile sheet call
  // this, which awaits the proc then re-groups on success (see runMovePost).
  const movePost = useCallback(
    (postId: string, toStage: Stage): void => {
      // Mirror runMovePost's in-flight guard so the busy bookkeeping only runs for
      // a move we actually start; a double-fire is dropped here (and again inside
      // runMovePost, which stays the authority for firing the proc once).
      if (inFlight.current.has(postId)) {
        return;
      }
      setMovingId(postId);
      void runMovePost(
        {
          client: supabase,
          posts,
          inFlight: inFlight.current,
          setPosts,
          onClose: () => setMovePostTarget(null),
          toast: push,
        },
        postId,
        toStage,
      ).finally(() => {
        setMovingId((current) => (current === postId ? null : current));
      });
    },
    [posts, push],
  );

  const steps: OnboardingStep[] = [
    {
      key: 'post',
      label: 'Create your first post',
      action: 'Create post',
      run: () => dispatchSorted('sorted:create-post'),
    },
    {
      key: 'invite',
      label: 'Invite a teammate',
      action: 'Invite',
      run: () => navigate('/settings?panel=members'),
    },
    {
      key: 'brief',
      label: 'Create your first brief',
      action: 'Create brief',
      run: () => dispatchSorted('sorted:create-brief'),
    },
  ];

  const visibleSteps = steps.filter((step) => skipped[step.key] !== true);

  // The onboarding card is for fresh workspaces only: once a workspace has real
  // content it should auto-hide, computed live with no persistence. "Has content"
  // means it carries posts AND more than a solo roster. Both signals reuse data
  // already on this surface: counts.all (the same filtered total the header shows)
  // for posts, and the RLS-scoped member roster the chat picker uses for members.
  // Default to HIDDEN while either signal is still loading or the member read
  // errored, so the card never flashes on a populated workspace. Manual dismiss
  // (X) and per-row Skip stay local-only and are unaffected.
  const members = useWorkspaceMembers(workspaceId ?? '');
  const signalsReady =
    workspaceId !== null && !postsLoading && !members.loading && members.error === null;
  const hasPosts = (counts.all ?? 0) >= 1;
  const activeMemberCount = members.options.length;
  const workspacePopulated = hasPosts && activeMemberCount >= 2;
  const workspaceEmptyEnough = signalsReady && !workspacePopulated;

  const showCard = !cardDismissed && visibleSteps.length > 0 && workspaceEmptyEnough;

  const boardLoading = workspaceId === null || (postsLoading && posts.length === 0);

  return (
    <>
      {pipelineHeader({
        search,
        onSearchChange: setSearch,
        sort: activeSort,
        onSortChange: setSort,
        dateWindow,
        onDateWindowChange: setDateWindow,
        customRange,
        onCustomRangeChange: setCustomRange,
        weekStartDay,
        stage,
        onStageChange: changeStage,
        counts,
      })}

      {/* Honest counter: the FILTERED total (counts.all, summed from the same
          grouped list the board/feed render), so it tracks the active search
          instead of freezing at the unfiltered posts.length. In Plan it is the
          week's posts plus every undated one, matching what that surface shows. */}
      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">{postCountLabel(shownCount)}</div>

      {showCard ? (
        <div className="px-4 md:px-6 mt-4">
          <div className="rounded-xl border border-border bg-panel-2 p-4">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Get started</div>
              <span className="ml-auto">
                <IconButton label="Dismiss" onClick={() => setCardDismissed(true)}>
                  <IconX size={16} />
                </IconButton>
              </span>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {visibleSteps.map((step) => (
                <li
                  key={step.key}
                  className="flex items-center gap-3 min-h-[44px] rounded-lg px-2 hover:bg-panel-3 transition-colors"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-fg-3 shrink-0">
                    <IconCheck size={14} />
                  </span>
                  <span className="flex-1 text-sm">{step.label}</span>
                  <Button variant="primary" size="sm" onClick={step.run}>
                    {step.action}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSkipped((prev) => ({ ...prev, [step.key]: true }))}
                  >
                    Skip
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {postsError !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load posts. {postsError}
          </div>
        </div>
      ) : boardLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading posts</div>
      ) : (
        pipelineSurface({
          stage,
          isDesktop,
          sorted,
          planPosts,
          grouped,
          timeZone,
          weekStartDay,
          weekOffset,
          onWeekOffsetChange: changeWeekOffset,
          canSetDate: agencySide,
          onSetDate: setSetDateTarget,
          onAddOnDay: addOnDay,
          sheetOpen: createOpen || movePostTarget !== null || setDateTarget !== null,
          cache,
          presignEnabled,
          workspaceKey,
          onViewAll: setStage,
          onMovePost: movePost,
          onLongPressPost: setMovePostTarget,
        })
      )}

      <MoveSheet
        open={movePostTarget !== null}
        post={movePostTarget}
        busy={movePostTarget !== null && movingId === movePostTarget.id}
        onClose={() => setMovePostTarget(null)}
        onMove={movePost}
      />

      <SetDateSheet
        open={setDateTarget !== null}
        post={setDateTarget}
        weekStart={planBounds.start}
        timeZone={timeZone}
        weekStartDay={weekStartDay}
        saving={savingDate}
        onPick={saveTargetDate}
        onClose={() => setSetDateTarget(null)}
      />

      <CreatePostSheet
        open={createOpen}
        workspaceId={workspaceId}
        {...(createTargetDate !== null ? { initialTargetDate: createTargetDate } : {})}
        onClose={() => {
          setCreateOpen(false);
          setCreateTargetDate(null);
        }}
        onCreated={() => {
          setCreateOpen(false);
          setCreateTargetDate(null);
          void loadPosts();
        }}
      />

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
