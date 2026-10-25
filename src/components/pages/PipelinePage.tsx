import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import type { PresignCache } from '@/lib/asset-presign';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { ICON_SIZE, IconCalendar, IconPipeline, IconPlus } from '@/components/ui/icons';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { StageChips } from '@/components/pages/pipeline/StageChips';
import type { StageChipItem } from '@/components/pages/pipeline/StageChips';
import { PipelineFilterControl } from '@/components/pages/pipeline/PipelineSortControl';
import { MoveSheet } from '@/components/pages/pipeline/MoveSheet';
import {
  StageMoveConfirm,
  needsConfirm,
  type ConfirmTarget,
} from '@/components/pages/pipeline/StageMoveConfirm';
import type { MoveOptions } from '@/components/pages/pipeline/approve-gate';
import {
  hasAllowedMove,
  firstNameOf,
  type CardViewer,
} from '@/components/pages/pipeline/card-status';
import { useWorkspacePeople } from '@/components/pages/pipeline/use-workspace-people';
import { postStageReason } from '@/components/pages/pipeline/stage-reason';
import { reasonFailureTitle } from '@/components/pages/pcs/stage-move-commit';
import { isClient } from '@/components/pages/pcs/roles';
import { requestPostCovers, usePostCovers, type CoverLookup } from '@/lib/chat/post-covers';
import { generateTraceId } from '@/lib/trace';
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
import {
  ROLE_READ_ERROR,
  readMemberRole,
  type RoleStatus,
} from '@/components/pages/pipeline/member-role';
import { canRoleMove } from '@/components/pages/pcs/stage-actions';
import {
  DATE_WINDOW_DEFAULT,
  POST_SORT_DEFAULT,
  POST_SORT_OPTIONS,
  filterByFields,
  filterByWindow,
  isUndated,
  sortPosts,
  type DateWindow,
  type PostSort,
} from '@/lib/list-sort';
import { groupByStage, stageColumns } from '@/lib/post-board';
import { frameFor } from '@/lib/platform-specs';
import { cn } from '@/lib/cn';
import { listPosts, STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type { Client, PipelinePost, Stage } from '@srtdio/posts';
import { errorCopy, errorText, type ErrorCopy } from '@/lib/error-copy';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

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
  /**
   * The post.create read is still in flight: the New post button's space is
   * held (an invisible, inert copy) so the header does not jump when it lands.
   */
  createPending?: boolean;
  /** Approvers never see the Draft chip. */
  hideDraft?: boolean;
}

/** The stage chips in transition-map order (Draft left out for approvers), All last. */
export function stageChipItems(
  counts: Record<string, number>,
  hideDraft: boolean,
): StageChipItem[] {
  return [
    ...STAGES.filter((stage) => !(hideDraft && stage === 'draft')).map((stage) => ({
      key: stage,
      label: stageLabel(stage),
      count: counts[stage] ?? 0,
      stage,
    })),
    { key: ALL_KEY, label: 'All', count: counts.all ?? 0 },
  ];
}

/** The New post button's classes: one row on every screen, never wraps or shrinks. */
const NEW_POST_CLASS = 'shrink-0 gap-1.5 whitespace-nowrap pl-3 pr-3.5';

/**
 * The Pipeline header chrome: the shared SectionHeader with, on ONE row at
 * every width, the search field (flex-1, shrinks), the single filter-and-sort
 * icon button, and the labelled New post button (plus icon + "New post"); the
 * horizontal stage chip bar sits in the filter-chips slot. Each chip carries
 * its label and post count as discrete fields (StageChips renders the count as
 * a trailing badge). Pure (no hooks) so the wiring is unit-tested by walking
 * the returned tree, mirroring SectionHeader's own tests; the page owns the
 * state and re-fetch.
 */
export function pipelineHeader(props: PipelineHeaderProps): ReactElement {
  // The stages keep their transition-map order, All closes the row.
  const hideDraft = props.hideDraft === true;
  const items = stageChipItems(props.counts, hideDraft);
  return (
    <div data-pipeline-toolbar="">
      <SectionHeader<PostSort>
        search={{
          value: props.search,
          onChange: props.onSearchChange,
          placeholder: 'Search posts',
        }}
        sort={{
          node: (
            <PipelineFilterControl
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
                    data-induction={INDUCTION_KEYS.pipelineCreate}
                    className={NEW_POST_CLASS}
                    onClick={() => dispatchSorted('sorted:create-post')}
                  >
                    <IconPlus size={ICON_SIZE.inline} />
                    New post
                  </Button>
                ),
              },
            }
          : props.createPending === true
            ? {
                primaryAction: {
                  node: (
                    <Button
                      variant="primary"
                      aria-hidden="true"
                      tabIndex={-1}
                      disabled
                      data-create-placeholder=""
                      className={cn('invisible', NEW_POST_CLASS)}
                    >
                      <IconPlus size={ICON_SIZE.inline} />
                      New post
                    </Button>
                  ),
                },
              }
            : {})}
      >
        <StageRow hideDraft={hideDraft}>
          <StageChips items={items} active={props.stage} onChange={props.onStageChange} />
        </StageRow>
      </SectionHeader>
    </div>
  );
}

/**
 * The stage row, marked for the induction. StageChips renders its own buttons,
 * so the Draft and Approved chips' keys are set on the rendered chips from here
 * (attribute only), found by their place in the row (no Draft chip for
 * approvers).
 */
function StageRow({
  children,
  hideDraft = false,
}: {
  children: ReactNode;
  hideDraft?: boolean;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const keys = stageChipItems({}, hideDraft).map((item) => item.key);
    const chips = ref.current?.querySelectorAll('button');
    const draft = keys.indexOf('draft');
    if (draft >= 0) {
      chips?.[draft]?.setAttribute('data-induction', INDUCTION_KEYS.pipelineDraftChip);
    }
    chips?.[keys.indexOf('approved')]?.setAttribute(
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

/** The action every failed move names: "Couldn't move the post. {reason}". */
const MOVE_ACTION = 'move the post';

/** The retry line for a failure with no plain reason (an unmapped code). */
export const MOVE_FALLBACK_MESSAGE = errorText(MOVE_ACTION, null);

/**
 * Map a failed move (a proc DomainError, a bare code, or a transport throw) to
 * the shared copy: "Couldn't move the post. Try again." with Retry, no
 * access, deleted, or the retry line. Raw server text never reaches the user.
 */
export function moveErrorCopy(error: unknown): ErrorCopy {
  const copy = errorCopy(MOVE_ACTION, error);
  // The reason goes to the log; the raw text never reaches the toast.
  logger.warn('pipeline: move refused', { reason: copy.reason });
  return copy;
}

/** As {@link moveErrorCopy}, the line only. */
export function moveErrorMessage(error: unknown): string {
  return moveErrorCopy(error).text;
}

/** A failure toast: the error tone, with Retry only when the reason is retryable. */
export interface MoveToastFailure {
  retry?: () => void;
}

// The failure options for a move that did not land: Retry re-runs it when
// trying again could help (offline, unknown), never for a refusal.
function moveFailure(copy: ErrorCopy, retry: () => void): MoveToastFailure {
  return copy.retryable ? { retry } : {};
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

/**
 * The honest narrowing count, "{shown} of {total} posts", shown only while a
 * search or date filter is on (the chips carry the counts otherwise). Without
 * `filtered` it is the plain total.
 */
export function headerCountLabel(shown: number, total: number, filtered: boolean): string {
  if (!filtered) return postCountLabel(total);
  return `${shown} of ${total} ${total === 1 ? 'post' : 'posts'}`;
}

/** Whether a stage chip, search or date window narrows the view. */
export function viewFiltered(query: PipelineQuery): boolean {
  return query.stage !== ALL_KEY || filtersActive(query);
}

/** The board's load failure: the shared plain line and a Retry that re-reads. */
export function postsLoadError(onRetry: () => void, retrying: boolean): ReactElement {
  return (
    <div data-posts-load-error="" className="mt-4 px-4 md:px-6">
      <LoadError title="posts" onRetry={onRetry} retrying={retrying} />
    </div>
  );
}

/** The empty list a workspace switch renders until its own read lands. */
const NO_POSTS: PipelinePost[] = [];
const NO_IDS: string[] = [];
/** Post ids per cover read, so the asset_attachments query stays a short URL. */
const COVER_BATCH = 100;

/** Skeleton cards: one board page's worth. */
const SKELETON_CARDS = BOARD_CAP;
/** Kanban skeleton: one column per stage, two cards each. */
const SKELETON_COLUMNS = STAGES.length;
const SKELETON_COLUMN_CARDS = 2;

/** What the loading skeleton mirrors: the real view and the card's picture frame. */
export interface SkeletonView {
  /** The laptop All view: the kanban columns, not a grid. */
  kanban?: boolean;
  /** The picture frame ratio (w / h) from the workspace platform; null: square. */
  ratio?: number | null;
  /** Kanban columns to draw (a client has no Draft column). Default: every stage. */
  columns?: number;
}

/** The skeleton picture frame: the workspace platform's single-image frame. Pure. */
export function skeletonRatio(platform: string | null | undefined): number | null {
  if (platform === null || platform === undefined) return null;
  return frameFor(platform, 'single_image', null)?.ratio ?? null;
}

/** One skeleton card in the real card's shape: picture, two title lines, the meta row. */
function skeletonCard(index: number, ratio: number | null): ReactElement {
  return (
    <div
      key={index}
      aria-hidden="true"
      data-skeleton-card=""
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel motion-safe:animate-pulse"
    >
      <div
        className={cn('bg-panel-2', ratio === null && 'aspect-square')}
        {...(ratio !== null ? { style: { aspectRatio: String(ratio) } } : {})}
      />
      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex min-h-[2.75em] flex-col justify-center gap-1.5 text-base leading-snug">
          <div className="h-3.5 w-3/4 rounded bg-panel-3" />
          <div className="h-3.5 w-1/2 rounded bg-panel-3" />
        </div>
        <div className="flex h-5 items-center">
          <div className="h-3 w-1/3 rounded bg-panel-3" />
        </div>
      </div>
    </div>
  );
}

/**
 * Card-shaped placeholders while the first read is in flight, in the real
 * view's layout: the kanban columns on the laptop All view, the full-width grid
 * on a laptop stage view, the 2-column grid on a phone. Each card takes the
 * workspace platform's frame, so nothing reshapes when the posts land.
 */
export function postsSkeleton(isDesktop: boolean, view: SkeletonView = {}): ReactElement {
  const ratio = view.ratio ?? null;
  const columns = view.columns ?? SKELETON_COLUMNS;
  if (isDesktop && view.kanban === true) {
    return (
      <div
        data-guide-wait=""
        data-posts-skeleton="kanban"
        role="status"
        aria-busy="true"
        className="flex min-h-0 gap-3 overflow-x-hidden px-4 py-4 md:px-6"
      >
        <span className="sr-only">Loading posts</span>
        {Array.from({ length: columns }, (_unused, column) => (
          <div
            key={column}
            aria-hidden="true"
            className="flex w-[260px] shrink-0 flex-col rounded-xl border border-border bg-panel-2"
          >
            <div className="flex h-11 items-center gap-2 border-b border-border px-3">
              <div className="h-3 w-1/3 rounded bg-panel-3" />
            </div>
            <div className="flex flex-col gap-2 p-2">
              {Array.from({ length: SKELETON_COLUMN_CARDS }, (_card, index) =>
                skeletonCard(index, ratio),
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      data-guide-wait=""
      data-posts-skeleton=""
      role="status"
      aria-busy="true"
      className={
        isDesktop
          ? 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 px-4 py-4 md:px-6'
          : 'grid grid-cols-2 gap-2 px-4 py-4'
      }
    >
      <span className="sr-only">Loading posts</span>
      {Array.from({ length: SKELETON_CARDS }, (_unused, index) => skeletonCard(index, ratio))}
    </div>
  );
}

/**
 * The pipeline with no posts at all (not a filter): one positive line. An
 * empty page has no create button of its own; the header's New post (the
 * induction's pipeline-create anchor) is the only one.
 */
export function emptyPipeline(): ReactElement {
  return (
    <div data-pipeline-empty="" className="px-4 md:px-6">
      <EmptyState icon={<IconPipeline size={ICON_SIZE.tray} />} title="Posts show up here." />
    </div>
  );
}

/** The searchable fields of a post: title and caption (the workspace has one platform). */
export function postSearchFields(post: PipelinePost): (string | null)[] {
  return [post.title, post.caption];
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
  onMovePost: (postId: string, toStage: Stage, options?: MoveOptions) => void;
  onLongPressPost: (post: PipelinePost) => void;
  /** The viewer's workspace role: filters the board's drop targets. */
  role: string | null;
  /** The role read has landed: only then are board cards draggable. Default true. */
  roleReady?: boolean;
  /** A desktop drop onto a column the post cannot move to: toast the reason. */
  onBlockedMove: (reason: string) => void;
  /** sessionStorage key for the feed's Show more depth (keyed by the filter query). */
  shownKey: string;
  /** The workspace zone each card reads its target (due) day in. Absent: the device zone. */
  timeZone?: string;
  /** The viewer's role and approvers: each card's status line and its ⋯. */
  viewer?: CardViewer;
  /** Each post's first photo or video, so its card takes the platform frame. */
  covers?: CoverLookup;
}

/** Clients never see Draft: no Draft chip, and no Draft column on the board. Pure. */
export function boardStages(stage: string, role: string | null): Stage[] {
  const columns = stageColumns(STAGES, stage);
  return isClient(role) ? columns.filter((s) => s !== 'draft') : columns;
}

/** The chip a client lands on when the URL names Draft (which they never see). Pure. */
export function visibleStage(stage: string, role: string | null): string {
  return isClient(role) && stage === 'draft' ? INITIAL_STAGE : stage;
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
        stages={boardStages(props.stage, props.role)}
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
        roleReady={props.roleReady !== false}
        {...(props.viewer !== undefined ? { viewer: props.viewer } : {})}
        {...(props.covers !== undefined ? { covers: props.covers } : {})}
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
      {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
      {...(props.viewer !== undefined ? { viewer: props.viewer } : {})}
      {...(props.covers !== undefined ? { covers: props.covers } : {})}
    />
  );
}

/**
 * The filtered empty state: search or a date window hides every post on this
 * view. The shared NoResults names what narrows it; its button resets both
 * (the stage chip stays). The unfiltered empty states (feed and board) are
 * untouched.
 */
export function filteredEmpty(
  search: string,
  dateActive: boolean,
  onClear: () => void,
): ReactElement {
  return (
    <div data-filtered-empty="" className="px-4 md:px-6">
      <NoResults query={search} filtersActive={dateActive} onClear={onClear} />
    </div>
  );
}

/** "This week. 2 posts with no date are hidden." Pure. */
export function undatedHiddenLine(label: string, count: number): string {
  return `${label}. ${count} ${count === 1 ? 'post' : 'posts'} with no date ${count === 1 ? 'is' : 'are'} hidden.`;
}

/**
 * While a date filter is on: how many undated posts it hides, with "Show them"
 * that adds them back. null when none are hidden.
 */
export function undatedHint(label: string, count: number, onShow: () => void): ReactElement | null {
  if (count <= 0) return null;
  return (
    <p data-undated-hint="" className="flex flex-wrap items-center gap-x-2 text-base text-fg-2">
      <IconCalendar size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
      <span>{undatedHiddenLine(label, count)}</span>
      <Button
        variant="link"
        type="button"
        onClick={onShow}
        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Show them
      </Button>
    </p>
  );
}

/**
 * Heal a persisted sort the trimmed menu no longer lists. Live workspaces stored
 * 'newest'/'title' from the old five-option menu; those map back to the
 * default. A value the menu lists passes through ('oldest' is listed again, as
 * "Least recently updated"). The store itself is left
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

/** The Undo toast title every move shows: "Moved to Review", "Moved to Approved". */
export function undoMoveLabel(toStage: Stage): string {
  return `Moved to ${stageLabel(toStage)}`;
}

/** {@link MovePostDeps} plus the Undo runner (useUndoableAction's run). */
export interface UndoableMoveDeps extends MovePostDeps {
  run: (action: UndoableAction) => void;
  /**
   * Posts the reject reason as a comment after the move lands (the post
   * page's comment call). Absent: a reason is dropped.
   */
  postReason?: (postId: string, body: string, traceId: string) => Promise<{ ok: boolean }>;
  /** Mints the move's trace id, shared by the move and its reason comment. */
  newTraceId?: () => string;
}

/**
 * The single move handler, for every move (the move sheet, the long-press and
 * the board drop): flip the post locally at once, close the sheet, and hand the
 * proc call to the "Moved to {Stage}" Undo toast. Undo puts the post back and
 * nothing is sent; the window running out (or the toast closing) sends
 * stage_transition once, with the on-behalf approver for an agency approve. A
 * failed send puts the post back and toasts the friendly error. The in-flight
 * guard holds from the flip until the send settles or Undo, so a double fire is
 * dropped. A move the stage map or the role does not allow never flips.
 */
export function runUndoableMove(
  deps: UndoableMoveDeps,
  postId: string,
  toStage: Stage,
  reason: string | null = null,
  options: MoveOptions = {},
): void {
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
  const retryMove = (): void => runUndoableMove(deps, postId, toStage, reason, options);
  const onBehalfOf = toStage === 'approved' ? options.onBehalfOf : undefined;
  deps.inFlight.add(postId);
  setStage(toStage);
  deps.onClose();
  deps.run({
    label: undoMoveLabel(toStage),
    commit: async () => {
      const traceId = deps.newTraceId?.();
      try {
        const result = await stageTransition(deps.client, {
          postId,
          toStage,
          ...(traceId !== undefined ? { traceId } : {}),
          ...(onBehalfOf !== undefined && onBehalfOf !== '' ? { onBehalfOf } : {}),
        });
        if (!result.ok) {
          revert();
          const copy = moveErrorCopy(result.error);
          deps.toast(copy.text, moveFailure(copy, retryMove));
          return;
        }
      } catch (error) {
        revert();
        const copy = moveErrorCopy(error);
        deps.toast(copy.text, moveFailure(copy, retryMove));
        return;
      }
      deps.inFlight.delete(postId);
      // The move landed; a typed reason follows as a comment on the same trace.
      if (reason !== null && deps.postReason !== undefined) {
        let posted = false;
        try {
          posted = (await deps.postReason(postId, reason, traceId ?? generateTraceId())).ok;
        } catch {
          posted = false;
        }
        // A partial failure: the move stands, the reason did not post.
        if (!posted) deps.toast(reasonFailureTitle(toStage), {});
      }
    },
    revert,
  });
}

/** Everything a move needs, so the page wires it and tests drive it directly. */
export interface MovePostDeps {
  client: Client;
  posts: PipelinePost[];
  /** In-flight post ids; the double-fire guard. Shared across calls (a ref's .current). */
  inFlight: Set<string>;
  setPosts: (updater: (prev: PipelinePost[]) => PipelinePost[]) => void;
  /** Close the move sheet (no-op on the desktop drag path). */
  onClose: () => void;
  /** Toast a line; `failure` marks it a failure (error tone, optional Retry). */
  toast: (message: string, failure?: MoveToastFailure) => void;
  /** The viewer's workspace role: a move this role may not make never reaches the proc. */
  role: string | null;
}

export function PipelinePage() {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Stage, search, date window and custom range live in the URL query so Back
  // restores them. Opens on Review when the query names no stage (a stale
  // ?view=plan link included: only the pipeline's own keys are read).
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parsePipelineQuery(params, INITIAL_STAGE), [params]);
  const { stage: queryStage, search, dateWindow, customRange } = query;
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
  const clearFilters = useCallback(
    (): void => updateQuery({ search: '', dateWindow: DATE_WINDOW_DEFAULT, customRange: null }),
    [updateQuery],
  );
  const shownKey = showMoreKey(pipelineQueryParams(query, INITIAL_STAGE).toString());
  const createCapability = useWorkspaceCapability('post.create');
  const canCreate = createCapability === true;
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
  // The workspace `posts` was read for. A switch renders nothing of the old
  // list: until the new read lands the board shows the skeleton.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadedForRef = useRef<string | null>(null);
  const loadSeq = useRef(0);
  // True from the first render so the empty pipeline never flashes before the read.
  const [postsLoading, setPostsLoading] = useState(true);
  // A failed read: the plain LoadError shows; the raw message never reaches the UI.
  const [postsFailed, setPostsFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [movePostTarget, setMovePostTarget] = useState<PipelinePost | null>(null);
  // A Reject, Park or Send for review waiting on its ask-first sheet.
  const [confirmMove, setConfirmMove] = useState<{
    post: PipelinePost;
    to: ConfirmTarget;
  } | null>(null);
  // "Show them": the date filter key whose undated posts were added back.
  const [undatedShownFor, setUndatedShownFor] = useState<string | null>(null);
  // Pipeline toasts ride the shared ui/toast surface; a ref keeps push stable.
  const toastApi = useOptionalToast();
  const toastRef = useRef(toastApi);
  toastRef.current = toastApi;
  // A failure rides the error tone (bad-solid), with Retry when it can help.
  const push = useCallback((message: string, failure?: MoveToastFailure): void => {
    const retry = failure?.retry;
    toastRef.current?.show({
      title: message,
      ...(failure !== undefined ? { tone: 'error' as const } : {}),
      ...(retry !== undefined ? { action: { label: 'Retry', onPress: retry } } : {}),
    });
  }, []);
  const { run: runUndoable } = useUndoableAction();
  // A post step of the induction opens the sheet with its preset.
  const postPreset = useInductionPostPreset();
  // The viewer's role, loaded once from the membership exactly as PCS does: it
  // filters the board's drop targets and the move sheet.
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const [role, setRole] = useState<string | null>(null);
  // Where the role read stands: the move sheet waits while 'loading' and
  // offers Retry on 'error' instead of blaming the role.
  const [roleStatus, setRoleStatus] = useState<RoleStatus>('loading');
  const [roleAttempt, setRoleAttempt] = useState(0);
  const retryRole = useCallback((): void => setRoleAttempt((n) => n + 1), []);
  // Clients never see Draft: a ?stage=draft link opens Review for them.
  const stage = visibleStage(queryStage, role);
  // Per-post in-flight guard for the move handler (a ref so a re-render never
  // resets it mid-flight); shared by the desktop drop and mobile sheet paths.
  const inFlight = useRef<Set<string>>(new Set());

  // One presign cache for the whole board: it bounds concurrency and caches
  // URLs so every card shares a single cap, mirroring AssetsPage. Cards
  // lazy-resolve their own thumbnail via useInView; the page adds no fetches.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();

  // One fetch for the whole board (no N+1): listPosts once, grouped in memory.
  // A read that lands after a newer one started (a workspace switch) is dropped.
  const loadPosts = useCallback(async () => {
    if (workspaceId === null) return;
    const seq = ++loadSeq.current;
    setPostsLoading(true);
    let ok = false;
    let data: PipelinePost[] = [];
    try {
      const result = await listPosts(supabase, { workspaceId, limit: 500 });
      if (result.ok) {
        ok = true;
        data = result.data;
      }
    } catch {
      // A transport throw (offline) is the same plain failure as an error Result.
    }
    if (seq !== loadSeq.current) return;
    if (ok) setPosts(data);
    else if (loadedForRef.current !== workspaceId) setPosts([]);
    loadedForRef.current = workspaceId;
    setLoadedFor(workspaceId);
    setPostsFailed(!ok);
    setPostsLoading(false);
  }, [workspaceId]);

  // A workspace switch closes the sheets on the old workspace's posts.
  useEffect(() => {
    setMovePostTarget(null);
    setConfirmMove(null);
  }, [workspaceId]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);
  // The sample week landing or clearing under the board: re-read it.
  useWorkspaceDataChanged(() => void loadPosts());
  // Only the active workspace's posts ever render.
  const live = workspaceId !== null && loadedFor === workspaceId;
  const shownPosts = live ? posts : NO_POSTS;

  // The approvers' names (card status, Send for review helper) and every
  // member's name (the creator in the reject confirm).
  const people = useWorkspacePeople(workspaceId);

  useEffect(() => {
    if (workspaceId === null || userId === null) {
      setRole(null);
      setRoleStatus('loading');
      return;
    }
    let cancelled = false;
    setRoleStatus('loading');
    void readMemberRole(supabase, workspaceId, userId).then((read) => {
      if (cancelled) return;
      if (read.ok) {
        setRole(read.role);
        setRoleStatus('ready');
      } else {
        setRole(null);
        setRoleStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId, roleAttempt]);

  // A blocked desktop drop names its reason only once the role is known; a
  // failed role read says so instead of blaming the role.
  const onBlockedMove = useCallback(
    (reason: string): void => {
      if (roleStatus === 'ready') push(reason);
      else if (roleStatus === 'error') push(ROLE_READ_ERROR, {});
    },
    [push, roleStatus],
  );

  // The Create (+) button and command palette dispatch this event; the sheet
  // lives here so the board can re-fetch on success.
  const navigate = useNavigate();
  const [createBriefId, setCreateBriefId] = useState<string | undefined>(undefined);
  useEffect(() => {
    function openCreate(): void {
      setCreateBriefId(undefined);
      setCreateOpen(true);
    }
    window.addEventListener('sorted:create-post', openCreate);
    return () => {
      window.removeEventListener('sorted:create-post', openCreate);
    };
  }, []);
  // New post from a brief: /pipeline?new=1&brief=<id> opens the sheet with that
  // brief chosen (and More options open); the query is then dropped so Back and
  // a reload do not reopen it.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    const brief = params.get('brief');
    setCreateBriefId(brief !== null && brief !== '' ? brief : undefined);
    setCreateOpen(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('brief');
    setParams(next, { replace: true });
  }, [params, setParams]);

  // Search + sort are pure, derived over the in-memory list (listPosts loads the
  // whole board), so no refetch and no N+1: filter by title + caption, then the
  // date window (undated posts kept once "Show them" is tapped for this window),
  // then order, then group into columns. groupByStage is generic over the
  // element type, so it preserves PipelinePost (thumbnailAssetVersionId and
  // all) with no assertion.
  const dateKey = `${dateWindow}:${customRange?.start ?? ''}:${customRange?.end ?? ''}`;
  const includeUndated = undatedShownFor === dateKey;
  const searched = useMemo(
    () => filterByFields(shownPosts, search, postSearchFields),
    [shownPosts, search],
  );
  const sorted = useMemo(
    () =>
      sortPosts(
        filterByWindow(searched, dateWindow, {
          now: new Date(),
          timeZone,
          weekStartDay,
          customRange,
          includeUndated,
        }),
        activeSort,
      ),
    [searched, dateWindow, customRange, activeSort, timeZone, weekStartDay, includeUndated],
  );
  const grouped = useMemo(() => groupByStage(sorted, STAGES), [sorted]);

  // Per-tab counts over the filtered list: each stage plus the 'all' total.
  const counts = useMemo(() => stageCounts(grouped, STAGES), [grouped]);

  // The empty view under active search/date filters gets NoResults ("Try fewer filters.").
  const visibleCount = (stage === ALL_KEY ? counts.all : counts[stage]) ?? 0;
  const inStage = (list: PipelinePost[]): PipelinePost[] =>
    stage === ALL_KEY ? list : list.filter((post) => post.stage === stage);

  // Counts live on the chips. Only while a search or date filter narrows the
  // view does a line say "{shown} of {total} posts" (total: this chip's posts).
  const narrowed = filtersActive(query);
  const countLabel = headerCountLabel(visibleCount, inStage(shownPosts).length, true);
  const showFilteredEmpty = narrowed && visibleCount === 0;
  // Undated posts the date window hides on this chip (after the search).
  const hiddenUndated =
    dateFilterActive(query) && !includeUndated ? inStage(searched).filter(isUndated).length : 0;

  // Card covers (first photo or video with its stored size) for the platform
  // frame, read in batches through the chat cover store; cached on the device.
  const covers = usePostCovers(NO_IDS);
  const coverKey = sorted.map((post) => post.id).join(',');
  useEffect(() => {
    if (workspaceId === null || coverKey === '') return;
    const ids = coverKey.split(',');
    for (let i = 0; i < ids.length; i += COVER_BATCH) {
      void requestPostCovers(supabase, workspaceId, ids.slice(i, i + COVER_BATCH));
    }
  }, [workspaceId, coverKey]);
  // While the role loads, review cards hold their status line's height.
  const rolePending = roleStatus === 'loading';
  const viewer = useMemo<CardViewer>(
    () => ({ role, approverFirstNames: people.approverFirstNames, pending: rolePending }),
    [role, people.approverFirstNames, rolePending],
  );

  // Single source for the move: the desktop drop and the mobile sheet both call
  // this. Every move flips at once and sends after the "Moved to {Stage}" Undo
  // window (see runUndoableMove, the authority for firing the proc once).
  const movePost = useCallback(
    (
      postId: string,
      toStage: Stage,
      reason: string | null = null,
      options: MoveOptions = {},
    ): void => {
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
          newTraceId: generateTraceId,
          postReason: (id, body, traceId) =>
            workspaceId === null
              ? Promise.resolve({ ok: false })
              : postStageReason(supabase, { workspaceId, postId: id, body, traceId, role }),
        },
        postId,
        toStage,
        reason,
        options,
      );
    },
    [posts, push, role, runUndoable, workspaceId],
  );

  // From the move sheet, Reject and Park ask first, and so does Send for review
  // from Draft; Approve has its own confirm in the sheet. Everything else moves.
  const requestSheetMove = useCallback(
    (postId: string, toStage: Stage, options?: MoveOptions): void => {
      const post = shownPosts.find((p) => p.id === postId);
      if (post === undefined) return;
      if (needsConfirm(post.stage as Stage, toStage, true)) {
        if (!canRoleMove(role, post.stage as Stage, toStage)) return;
        setMovePostTarget(null);
        setConfirmMove({ post, to: toStage });
        return;
      }
      movePost(postId, toStage, null, options);
    },
    [shownPosts, movePost, role],
  );
  // A board drop moves at once with no confirm; only a drop on Approved asks,
  // through the board's own approve (or on-behalf) sheet, before it lands here.
  const requestBoardMove = useCallback(
    (postId: string, toStage: Stage, options?: MoveOptions): void =>
      movePost(postId, toStage, null, options),
    [movePost],
  );
  // A long-press on a card this viewer cannot move does nothing.
  const openMove = useCallback(
    (post: PipelinePost): void => {
      if (roleStatus === 'ready' && !hasAllowedMove(role, post.stage as Stage)) return;
      setMovePostTarget(post);
    },
    [role, roleStatus],
  );
  const confirmCreator =
    confirmMove === null
      ? null
      : firstNameOf(
          people.names.get(confirmMove.post.owner_user_id ?? confirmMove.post.created_by ?? ''),
        );

  const boardLoading =
    workspaceId === null || !live || (postsLoading && posts.length === 0 && !postsFailed);
  // No posts at all (not a filter hiding them) once a read has succeeded.
  const pipelineEmpty = !boardLoading && !postsFailed && !postsLoading && shownPosts.length === 0;

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
        createPending: createCapability === null,
        hideDraft: isClient(role),
      })}

      {/* Counts live on the chips. While a search or date filter narrows the
          view: the honest "{shown} of {total} posts", and the undated posts the
          date filter hides with "Show them". */}
      {narrowed && !boardLoading && !postsFailed ? (
        <div className="flex flex-col gap-1 px-4 pt-3 md:px-6">
          <span data-posts-count="" className="text-base text-fg-3">
            {countLabel}
          </span>
          {undatedHint(dateChipLabel(query), hiddenUndated, () => setUndatedShownFor(dateKey))}
        </div>
      ) : null}

      {/* The chips and filters above stay usable through a failed read. */}
      {live && postsFailed
        ? postsLoadError(() => void loadPosts(), postsLoading)
        : boardLoading
          ? postsSkeleton(isDesktop, {
              kanban: stage === ALL_KEY,
              ratio: skeletonRatio(activeWorkspace?.platform),
              columns: boardStages(stage, role).length,
            })
          : pipelineEmpty
            ? emptyPipeline()
            : showFilteredEmpty
              ? filteredEmpty(query.search, dateFilterActive(query), clearFilters)
              : pipelineSurface({
                  stage,
                  isDesktop,
                  sorted,
                  grouped,
                  cache,
                  presignEnabled,
                  workspaceKey,
                  onViewAll: setStage,
                  onMovePost: requestBoardMove,
                  onLongPressPost: openMove,
                  role,
                  roleReady: roleStatus === 'ready',
                  onBlockedMove,
                  shownKey,
                  timeZone,
                  viewer,
                  covers,
                })}

      <MoveSheet
        open={movePostTarget !== null}
        post={movePostTarget}
        onClose={() => setMovePostTarget(null)}
        onMove={requestSheetMove}
        role={role}
        roleStatus={roleStatus}
        onRetryRole={retryRole}
      />

      <StageMoveConfirm
        pending={confirmMove}
        creatorFirstName={confirmCreator}
        approverFirstNames={people.approverFirstNames}
        onCancel={() => setConfirmMove(null)}
        onConfirm={(postId, to, reason) => {
          setConfirmMove(null);
          movePost(postId, to, reason);
        }}
      />

      <CreatePostSheet
        open={createOpen}
        workspaceId={workspaceId}
        {...(postPreset !== undefined ? { preset: postPreset } : {})}
        {...(createBriefId !== undefined ? { initialBriefId: createBriefId } : {})}
        onClose={() => setCreateOpen(false)}
        onCreated={(_postId, outcome) => {
          setCreateOpen(false);
          void loadPosts();
          // The full sheet lands on the new post; the first-post preset stays here.
          if (outcome !== undefined) navigate(outcome.path);
        }}
      />
    </>
  );
}
