import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useOptionalToast } from '@/components/ui/toast';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconCalendar, IconPipeline, IconPlus, IconX } from '@/components/ui/icons';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { StageChips } from '@/components/pages/pipeline/StageChips';
import type { StageChipItem } from '@/components/pages/pipeline/StageChips';
import { PipelineSortControl } from '@/components/pages/pipeline/PipelineSortControl';
import { MoveSheet } from '@/components/pages/pipeline/MoveSheet';
import { BOARD_CAP, stageLabel } from '@/components/pages/pipeline/stage-meta';
import {
  dateChipLabel,
  dateFilterActive,
  filtersActive,
  parsePipelineQuery,
  pipelineQueryParams,
  showMoreKey,
  type DateRange,
  type PipelineQuery,
} from '@/components/pages/pipeline/pipeline-query';
import { useUndoableAction, type UndoableAction } from '@/lib/use-undoable-action';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { dispatchSorted } from '@/lib/events';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { INDUCTION_KEYS } from '@/lib/induction';
import { useInductionPostPreset } from '@/components/induction/InductionProvider';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useMediaQuery } from '@/lib/use-media-query';
import { useSort } from '@/lib/use-sort';
import { useSession } from '@/lib/session-context';
import { fetchMemberRole } from '@/lib/assets';
import { canRoleMove, roleMayTarget } from '@/components/pages/pcs/stage-actions';
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
import { groupByStage, stageColumns } from '@/lib/post-board';
import { listPosts, STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type { Client, DomainErrorCode, PipelinePost, Stage } from '@srtdio/posts';
import { PresignCache } from '@/lib/asset-presign';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';

// The board columns are the workflow stages, in transition-map order. Stage
// values come from the @srtdio/posts type, never hardcoded literals in JSX.
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

/** The UI-only chip key: not a workflow stage, the existing unfiltered board. */
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
  /** post.create granted: only then does the header carry the "+" create button. */
  canCreate: boolean;
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
  // The five stages keep their transition-map order, All closes the row.
  const items: StageChipItem[] = [
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
      {...(props.canCreate
        ? {
            primaryAction: {
              node: (
                <Button
                  variant="primary"
                  size="lg"
                  aria-label="Create post"
                  data-induction={INDUCTION_KEYS.pipelineCreate}
                  className="w-11 px-0"
                  onClick={() => dispatchSorted('sorted:create-post')}
                >
                  <IconPlus size={18} />
                </Button>
              ),
            },
          }
        : {})}
    >
      <StageRow>
        <StageChips items={items} active={props.stage} onChange={props.onStageChange} />
      </StageRow>
    </SectionHeader>
  );
}

/** The Draft chip's place in the row: the stages keep transition-map order. */
const DRAFT_CHIP_INDEX = STAGES.indexOf('draft');
/** The Approved chip's place in the row, by the same transition-map order. */
const APPROVED_CHIP_INDEX = STAGES.indexOf('approved');

/**
 * The stage row, marked for the induction. StageChips renders its own buttons,
 * so the Draft chip's key is set on the rendered chip from here (attribute only).
 */
function StageRow({ children }: { children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chips = ref.current?.querySelectorAll('button');
    chips?.[DRAFT_CHIP_INDEX]?.setAttribute('data-induction', INDUCTION_KEYS.pipelineDraftChip);
    chips?.[APPROVED_CHIP_INDEX]?.setAttribute(
      'data-induction',
      INDUCTION_KEYS.pipelineApprovedChip,
    );
  });
  return (
    <div ref={ref} data-induction={INDUCTION_KEYS.pipelineStageRow}>
      {children}
    </div>
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

/** Everything {@link pipelineSurface} needs to pick and wire the active surface. */
export interface PipelineSurfaceProps {
  /** The active chip: ALL_KEY or a Stage. */
  stage: string;
  isDesktop: boolean;
  /** Search + window + sort; the board and feed list. */
  sorted: PipelinePost[];
  grouped: Record<Stage, PipelinePost[]>;
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey: string | null;
  onViewAll: (stage: Stage) => void;
  onMovePost: (postId: string, toStage: Stage) => void;
  onLongPressPost: (post: PipelinePost) => void;
  /** The viewer's workspace role: filters the board's drop targets. */
  role: string | null;
  /** A desktop drop onto a column the post cannot move to: toast the reason. */
  onBlockedMove: (reason: string) => void;
  /** sessionStorage key for the feed's Show more depth (keyed by the filter query). */
  shownKey: string;
}

/**
 * Pick the body surface for the active chip: the desktop kanban or the mobile
 * feed. Pure (no hooks; the components it returns own their own state) so the
 * branch is unit-tested by walking the element.
 */
export function pipelineSurface(props: PipelineSurfaceProps): ReactElement {
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
        role={props.role}
        onOpenMove={props.onLongPressPost}
        onBlockedMove={props.onBlockedMove}
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
      shownKey={props.shownKey}
    />
  );
}

/**
 * The filtered empty state: search or a date window hides every post on this
 * view. "Clear filters" resets both (the stage chip stays). The unfiltered
 * empty states (feed and board) are untouched.
 */
export function filteredEmpty(onClear: () => void): ReactElement {
  return (
    <div data-filtered-empty="" className="px-4 md:px-6">
      <EmptyState
        icon={<IconPipeline size={22} />}
        title="No matches"
        action={
          <Button variant="default" size="lg" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    </div>
  );
}

/** The active date filter as a chip with a 44px X that clears it (phones too). */
export function dateFilterChip(label: string, onClear: () => void): ReactElement {
  return (
    <span
      data-date-chip=""
      className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-border bg-panel-2 pl-3 text-xs text-fg-2"
    >
      <IconCalendar size={14} className="shrink-0 text-fg-3" />
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label="Clear date filter"
        onClick={onClear}
        className="-my-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconX size={14} />
      </button>
    </span>
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

/**
 * The stage chip the page opens on: always Review. Pipeline no longer has a
 * Plan surface, so a stale `?view=plan` (or `?week`) link opens Review too.
 */
export const INITIAL_STAGE = 'review';

/** Moves that wait out an Undo window before the proc is sent. */
export function isUndoableMove(toStage: Stage): boolean {
  return toStage === 'rejected' || toStage === 'parked';
}

/** The Undo toast title: "Moved to Rejected", "Moved to Parked". */
export function undoMoveLabel(toStage: Stage): string {
  return `Moved to ${stageLabel(toStage)}`;
}

/** {@link runMovePost}'s deps plus the Undo runner (useUndoableAction's run). */
export interface UndoableMoveDeps extends MovePostDeps {
  run: (action: UndoableAction) => void;
}

/**
 * A move to Rejected or Parked: flip the post locally at once, close the sheet,
 * and hand the proc call to the Undo toast. Undo puts the post back and nothing
 * is sent; the window running out (or the toast closing) sends stage_transition
 * once. A failed send puts the post back and toasts the friendly error. The
 * in-flight guard holds from the flip until the send settles or Undo.
 */
export function runUndoableMove(deps: UndoableMoveDeps, postId: string, toStage: Stage): void {
  if (deps.inFlight.has(postId)) {
    return;
  }
  const target = deps.posts.find((post) => post.id === postId);
  if (target === undefined) {
    return;
  }
  // posts.stage is a DB text column (typed string); it is one of the Stage values.
  const fromStage = target.stage as Stage;
  // Optimistic, so only a move the stage map and the role allow ever flips.
  if (!canRoleMove(deps.role, fromStage, toStage)) {
    return;
  }
  const setStage = (stage: Stage): void =>
    deps.setPosts((prev) => prev.map((post) => (post.id === postId ? { ...post, stage } : post)));
  const revert = (): void => {
    setStage(fromStage);
    deps.inFlight.delete(postId);
  };
  deps.inFlight.add(postId);
  setStage(toStage);
  deps.onClose();
  deps.run({
    label: undoMoveLabel(toStage),
    commit: async () => {
      try {
        const result = await stageTransition(deps.client, { postId, toStage });
        if (!result.ok) {
          revert();
          deps.toast(moveErrorMessage(result.error.code));
          return;
        }
      } catch {
        revert();
        deps.toast(MOVE_FALLBACK_MESSAGE);
        return;
      }
      deps.inFlight.delete(postId);
    },
    revert,
  });
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
  /** The viewer's workspace role: a move this role may not make never reaches the proc. */
  role: string | null;
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
  // A target this role may never trigger (a client parking or sending back to
  // review) never reaches the proc; legality from the stage stays the proc's.
  if (!roleMayTarget(deps.role, toStage)) {
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

export function PipelinePage() {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Stage, search, date window and custom range live in the URL query so Back
  // restores them. Opens on Review when the query names no stage (a stale
  // ?view=plan link included: only the pipeline's own keys are read).
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parsePipelineQuery(params, INITIAL_STAGE), [params]);
  const { stage, search, dateWindow, customRange } = query;
  // Patches compose through a ref: the sort control's Apply sets the range and
  // the window back to back, before the URL re-renders the page.
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const updateQuery = useCallback(
    (patch: Partial<PipelineQuery>): void => {
      const next = { ...latestQuery.current, ...patch };
      latestQuery.current = next;
      setParams(pipelineQueryParams(next, INITIAL_STAGE), { replace: true });
    },
    [setParams],
  );
  const setStage = useCallback((key: string): void => updateQuery({ stage: key }), [updateQuery]);
  const setSearch = useCallback(
    (value: string): void => updateQuery({ search: value }),
    [updateQuery],
  );
  const setDateWindow = useCallback(
    (value: DateWindow): void => updateQuery({ dateWindow: value }),
    [updateQuery],
  );
  const setCustomRange = useCallback(
    (range: DateRange | null): void => updateQuery({ customRange: range }),
    [updateQuery],
  );
  const clearDate = useCallback(
    (): void => updateQuery({ dateWindow: DATE_WINDOW_DEFAULT, customRange: null }),
    [updateQuery],
  );
  const clearFilters = useCallback(
    (): void => updateQuery({ search: '', dateWindow: DATE_WINDOW_DEFAULT, customRange: null }),
    [updateQuery],
  );
  const shownKey = showMoreKey(pipelineQueryParams(query, INITIAL_STAGE).toString());
  const canCreate = useWorkspaceCapability('post.create') === true;
  const { value: sort, setValue: setSort } = useSort<PostSort>('pipeline', POST_SORT_DEFAULT);
  // Sanitize the persisted sort: a live workspace may hold a value the trimmed
  // menu no longer lists ('newest'/'title'). Fall back to the default for the
  // derivation and the header, but leave setSort untouched so the first user pick
  // heals storage.
  const activeSort = sanitizePostSort(sort);
  // The active workspace's civil-date context for the window filter; the helper
  // re-validates the zone, so a bad stored value is still safe.
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId);
  const timeZone = activeWorkspace?.timezone ?? 'UTC';
  const weekStartDay = activeWorkspace?.week_start_day ?? 1;

  const [posts, setPosts] = useState<PipelinePost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [movePostTarget, setMovePostTarget] = useState<PipelinePost | null>(null);
  // Reactive mirror of the in-flight guard for the open move sheet: the guard
  // itself is a ref (no re-render), so this state drives the sheet's busy prop.
  const [movingId, setMovingId] = useState<string | null>(null);
  // Pipeline toasts ride the shared ui/toast surface; a ref keeps push stable.
  const toastApi = useOptionalToast();
  const toastRef = useRef(toastApi);
  toastRef.current = toastApi;
  const push = useCallback((message: string): void => {
    toastRef.current?.show({ title: message });
  }, []);
  const { run: runUndoable } = useUndoableAction();
  // A post step of the induction opens the sheet with its preset.
  const postPreset = useInductionPostPreset();
  // The viewer's role, loaded once from the membership exactly as PCS does: it
  // filters the board's drop targets and the move sheet.
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const [role, setRole] = useState<string | null>(null);
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
  // The sample week landing or clearing under the board: re-read it.
  useWorkspaceDataChanged(() => void loadPosts());

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

  // The header counter: the filtered board total.
  const shownCount = counts.all ?? 0;

  // The empty view under active search/date filters gets "No matches".
  const visibleCount = (stage === ALL_KEY ? counts.all : counts[stage]) ?? 0;
  const showFilteredEmpty = filtersActive(query) && visibleCount === 0;

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
      // Rejected and Parked flip now and send after the Undo window.
      if (isUndoableMove(toStage)) {
        runUndoableMove(
          {
            client: supabase,
            posts,
            inFlight: inFlight.current,
            setPosts,
            onClose: () => setMovePostTarget(null),
            toast: push,
            role,
            run: runUndoable,
          },
          postId,
          toStage,
        );
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
          role,
        },
        postId,
        toStage,
      ).finally(() => {
        setMovingId((current) => (current === postId ? null : current));
      });
    },
    [posts, push, role, runUndoable],
  );

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
        onStageChange: setStage,
        counts,
        canCreate,
      })}

      {/* Honest counter: the FILTERED total (counts.all, summed from the same
          grouped list the board/feed render), so it tracks the active search
          instead of freezing at the unfiltered posts.length. */}
      <div className="flex min-h-[44px] flex-wrap items-center gap-2 px-4 pt-3 md:px-6">
        <span className="text-sm text-fg-3">{postCountLabel(shownCount)}</span>
        {dateFilterActive(query) ? dateFilterChip(dateChipLabel(query), clearDate) : null}
      </div>

      {postsError !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load posts. {postsError}
          </div>
        </div>
      ) : boardLoading ? (
        <div data-guide-wait="" className="px-4 md:px-6 py-10 text-sm text-fg-3">
          Loading posts
        </div>
      ) : showFilteredEmpty ? (
        filteredEmpty(clearFilters)
      ) : (
        pipelineSurface({
          stage,
          isDesktop,
          sorted,
          grouped,
          cache,
          presignEnabled,
          workspaceKey,
          onViewAll: setStage,
          onMovePost: movePost,
          onLongPressPost: setMovePostTarget,
          role,
          onBlockedMove: push,
          shownKey,
        })
      )}

      <MoveSheet
        open={movePostTarget !== null}
        post={movePostTarget}
        busy={movePostTarget !== null && movingId === movePostTarget.id}
        onClose={() => setMovePostTarget(null)}
        onMove={movePost}
        role={role}
      />

      <CreatePostSheet
        open={createOpen}
        workspaceId={workspaceId}
        {...(postPreset !== undefined ? { preset: postPreset } : {})}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void loadPosts();
        }}
      />
    </>
  );
}
