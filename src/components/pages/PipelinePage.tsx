import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import type { PresignCache } from '@/lib/asset-presign';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { LIST_CARD_GRID, ListCardBox, type ListCardSelect } from '@/components/ui/ListCard';
import {
  SelectBar,
  useListSelection,
  visibleSelectActions,
  type SelectBarAction,
} from '@/components/ui/SelectBar';
import { GUTTER } from '@/components/ui/layout';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import { PageHead } from '@/components/shell/PageHead';
import { SectionHeader } from '@/components/shell/SectionHeader';
import {
  ICON_SIZE,
  IconArrowUpRight,
  IconBan,
  IconCalendar,
  IconCheck,
  IconLink,
  IconPause,
  IconPipeline,
  IconPlus,
  IconSwitch,
  type IconProps,
} from '@/components/ui/icons';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { StageChips } from '@/components/pages/pipeline/StageChips';
import type { StageChipItem } from '@/components/pages/pipeline/StageChips';
import { PipelineFilterControl } from '@/components/pages/pipeline/PipelineSortControl';
import { MoveSheet, moveActions } from '@/components/pages/pipeline/MoveSheet';
import { openPostCard, postCardHref } from '@/components/pages/PostCard';
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
import {
  primeCovers,
  requestPostCovers,
  usePostCovers,
  type CoverLookup,
} from '@/lib/chat/post-covers';
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
import { useSort } from '@/lib/use-sort';
import { useSession } from '@/lib/session-context';
import { dispatchPostChanged } from '@/components/chat/post-sheet';
import {
  keptPipelinePosts,
  primePipelinePosts,
  readPipelinePosts,
  searchPipelinePosts,
  stalePipelinePosts,
  PIPELINE_POSTS_LIMIT,
} from '@/lib/pipeline-posts';
import { useServerSearch } from '@/lib/search/server-search';
import { keptViewKey, useKeptScroll, useKeptState, useUntouched } from '@/lib/kept-view';
import { readMemberRole, type RoleStatus } from '@/components/pages/pipeline/member-role';
import { canRoleMove } from '@/components/pages/pcs/stage-actions';
import {
  DATE_WINDOW_DEFAULT,
  POST_SORT_DEFAULT,
  POST_SORT_OPTIONS,
  filterByWindow,
  isUndated,
  sortPosts,
  type DateWindow,
  type PostSort,
} from '@/lib/list-sort';
import { groupByStage } from '@/lib/post-board';
import { cn } from '@/lib/cn';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import { listPosts, STAGE_TRANSITIONS, stageTransition } from '@srtdio/posts';
import type { Client, PipelinePost, Stage } from '@srtdio/posts';
import { errorCopy, errorText, type ErrorCopy } from '@/lib/error-copy';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { buildPostLink } from '@/lib/post-share';

// The board columns are the workflow stages, in transition-map order. Stage
// values come from the @srtdio/posts type, never hardcoded literals in JSX.
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

/** The UI-only chip key: not a workflow stage, the existing unfiltered board. */
const ALL_KEY = 'all';

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
const NEW_POST_CLASS = 'shrink-0 whitespace-nowrap';

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
          label: 'Search posts',
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
    <div data-posts-load-error="" className={cn('mt-4', GUTTER)}>
      <LoadError title="posts" onRetry={onRetry} retrying={retrying} />
    </div>
  );
}

/** The empty list a workspace switch renders until its own read lands. */
const NO_POSTS: PipelinePost[] = [];
const NO_IDS: string[] = [];
/** Post ids per cover read, so the asset_attachments query stays a short URL. */
const COVER_BATCH = 100;

/** The cover read's key: the distinct post ids, sorted, comma-joined. Pure. */
export function coverIdsKey(posts: readonly Pick<PipelinePost, 'id'>[]): string {
  return [...new Set(posts.map((post) => post.id))].sort().join(',');
}

/**
 * The covers listPosts already returned (the first_media_* columns of its one
 * posts_list call, no attachments read), as store entries; rows without
 * `firstMedia` (never read) are left out. Pure.
 */
export function listedCovers(
  posts: readonly Pick<PipelinePost, 'id' | 'firstMedia'>[],
): Array<[string, NonNullable<PipelinePost['firstMedia']> | null]> {
  const out: Array<[string, NonNullable<PipelinePost['firstMedia']> | null]> = [];
  for (const post of posts) {
    if (post.firstMedia !== undefined) out.push([post.id, post.firstMedia]);
  }
  return out;
}

/** Loading boxes: one list page's worth. */
const SKELETON_CARDS = BOARD_CAP;

/**
 * ui/ListCardBox placeholders while the first read is in flight, in the real
 * list's container and grid (LIST_CARD_GRID, phone and laptop alike), so
 * nothing moves when the cards land.
 */
export function postsSkeleton(): ReactElement {
  mark('pipeline:skeleton');
  return (
    <div
      data-guide-wait=""
      data-posts-skeleton=""
      role="status"
      aria-busy="true"
      className={cn('py-4', GUTTER)}
    >
      <span className="sr-only">Loading posts</span>
      <div aria-hidden="true" className={LIST_CARD_GRID}>
        {Array.from({ length: SKELETON_CARDS }, (_unused, index) => (
          <ListCardBox key={`skeleton-${index}`} data-skeleton-card="" />
        ))}
      </div>
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
    <div data-pipeline-empty="" className={GUTTER}>
      <EmptyState icon={<IconPipeline size={ICON_SIZE.tray} />} title="Posts show up here." />
    </div>
  );
}

/** The searchable fields of a post: title and caption (the workspace has one platform). */
export function postSearchFields(post: PipelinePost): (string | null)[] {
  return [post.title, post.caption];
}

/** Everything {@link pipelineSurface} needs to wire the list. */
export interface PipelineSurfaceProps {
  /** The active chip: ALL_KEY or a Stage. */
  stage: string;
  /** Search + window + sort: the list. */
  sorted: PipelinePost[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey: string | null;
  /** The page's select mode: each card's long-press / right-click ticks it. */
  selectFor?: (postId: string) => ListCardSelect;
  /** sessionStorage key for the feed's Show more depth (keyed by the filter query). */
  shownKey: string;
  /** The workspace zone each card reads its target (due) day in. Absent: the device zone. */
  timeZone?: string;
  /** The viewer's role and approvers: each card's status line. */
  viewer?: CardViewer;
  /** Each post's first photo or video (a video with no poster shows the play placeholder). */
  covers?: CoverLookup;
}

/** The chip a client lands on when the URL names Draft (which they never see). Pure. */
export function visibleStage(stage: string, role: string | null): string {
  return isClient(role) && stage === 'draft' ? INITIAL_STAGE : stage;
}

/**
 * The body surface: the one list (PipelineFeed, ui/ListCard in
 * LIST_CARD_GRID) on phone and laptop, driven by the stage chips. Pure (no
 * hooks; the feed owns its own state) so the wiring is unit-tested by walking
 * the element.
 */
export function pipelineSurface(props: PipelineSurfaceProps): ReactElement {
  mark('pipeline:cards');
  return (
    <PipelineFeed
      posts={props.sorted}
      activeStage={props.stage}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      workspaceKey={props.workspaceKey}
      {...(props.selectFor !== undefined ? { selectFor: props.selectFor } : {})}
      shownKey={props.shownKey}
      {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
      {...(props.viewer !== undefined ? { viewer: props.viewer } : {})}
      {...(props.covers !== undefined ? { covers: props.covers } : {})}
    />
  );
}

/** One icon per move: Send for review arrow, Approve check, Park pause, Reject ban (no X). */
const MOVE_ICON: Record<Stage, ComponentType<IconProps>> = {
  draft: IconSwitch,
  review: IconArrowUpRight,
  approved: IconCheck,
  parked: IconPause,
  rejected: IconBan,
};

/** One select bar row; `single` rows show only while exactly one post is ticked. */
export type PipelineSelectRow = SelectBarAction & { single?: boolean };

/** What the Pipeline's select bar runs. */
export interface PipelineSelectInput {
  /** The one ticked post, or null while none or several are ticked. */
  post: PipelinePost | null;
  /** How many posts are ticked. */
  count: number;
  viewer: CardViewer;
  onOpen: (post: PipelinePost) => void;
  onCopyLink: (post: PipelinePost) => void;
  /** A move row passes its target; Move (no target) opens the move sheet. */
  onMove: (post: PipelinePost, to?: Stage) => void;
}

/**
 * The Pipeline's select bar actions: the old card ⋮ rows, in their order.
 * Open, Copy link, then every move this viewer can make from the post's stage
 * (the move sheet's own list: Send for review, Approve, Park, Reject) once the
 * role is known, else Move (the move sheet) while it loads. Every row is
 * per-post (the move sheet takes one post and approval is never bulk), so all
 * are `single`: with two or more ticked the bar holds Cancel and the count
 * only. A viewer with no allowed move gets no move row. Pure.
 */
export function pipelineSelectActions(input: PipelineSelectInput): SelectBarAction[] {
  const { post, count, viewer } = input;
  if (post === null) return [];
  const stage = post.stage as Stage;
  // While the role loads the move sheet waits for it, so Move shows.
  const canMove = viewer.pending === true || hasAllowedMove(viewer.role, stage);
  const direct = viewer.pending !== true ? moveActions(viewer.role, stage) : [];
  const moves: PipelineSelectRow[] = !canMove
    ? []
    : direct.length > 0
      ? direct.map((move) => ({
          id: `move-${move.to}`,
          label: move.label,
          icon: MOVE_ICON[move.to],
          ...(move.tone === 'bad' ? { tone: 'bad' as const } : {}),
          single: true,
          onSelect: () => input.onMove(post, move.to),
        }))
      : [
          {
            id: 'move',
            label: 'Move',
            icon: IconSwitch,
            single: true,
            onSelect: () => input.onMove(post),
          },
        ];
  const rows: PipelineSelectRow[] = [
    {
      id: 'open',
      label: 'Open',
      icon: IconArrowUpRight,
      single: true,
      onSelect: () => input.onOpen(post),
    },
    {
      id: 'copy-link',
      label: 'Copy link',
      icon: IconLink,
      single: true,
      onSelect: () => input.onCopyLink(post),
    },
    ...moves,
  ];
  return visibleSelectActions(rows, count);
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
    <div data-filtered-empty="" className={GUTTER}>
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
      <Button variant="link" type="button" onClick={onShow}>
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
  /** The move landed on the server (the page tells the other surfaces). */
  onLanded?: (postId: string) => void;
}

/**
 * The single move handler, for every move (the move sheet and the select
 * bar's move rows): flip the post locally at once, close the sheet, and hand the
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
  mark('decision:optimistic');
  setStage(toStage);
  deps.onClose();
  deps.run({
    label: undoMoveLabel(toStage),
    commit: async () => {
      const traceId = deps.newTraceId?.();
      try {
        mark('decision:rpc:start');
        const result = await stageTransition(deps.client, {
          postId,
          toStage,
          ...(traceId !== undefined ? { traceId } : {}),
          ...(onBehalfOf !== undefined && onBehalfOf !== '' ? { onBehalfOf } : {}),
        });
        mark('decision:rpc:end');
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
      deps.onLanded?.(postId);
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
  /** Close the move sheet. */
  onClose: () => void;
  /** Toast a line; `failure` marks it a failure (error tone, optional Retry). */
  toast: (message: string, failure?: MoveToastFailure) => void;
  /** The viewer's workspace role: a move this role may not make never reaches the proc. */
  role: string | null;
}

/**
 * Whether a path is a post's page (/posts/:id, or the pretty /p/KEY-N), where
 * the post can change without a post-changed event. Pure.
 */
export function leavingToPost(pathname: string): boolean {
  return pathname.startsWith('/posts/') || pathname.startsWith('/p/');
}

/**
 * The query the board shows: the URL's, or, when the URL names no filter (a
 * tab return lands on a clean /pipeline), the chip and date filter kept from
 * this session's last visit. The search is never kept. Pure.
 */
export function shownPipelineQuery(
  params: URLSearchParams,
  kept: PipelineQuery | null,
): PipelineQuery {
  const fromUrl = parsePipelineQuery(params, INITIAL_STAGE);
  const clean = pipelineQueryParams(fromUrl, INITIAL_STAGE).toString() === '';
  return clean && kept !== null ? { ...kept, search: '' } : fromUrl;
}

export function PipelinePage() {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const viewKey = useCallback(
    (part: string): string | null =>
      userId !== null && workspaceId !== null ? keptViewKey(userId, workspaceId, part) : null,
    [userId, workspaceId],
  );
  // Stage, search, date window and custom range live in the URL query so Back
  // restores them. Opens on Review when the query names no stage (a stale
  // ?view=plan link included: only the pipeline's own keys are read), or on
  // the chip and date filter kept from this session's last visit.
  const [params, setParams] = useSearchParams();
  const [keptQuery, setKeptQuery] = useKeptState<PipelineQuery | null>(
    viewKey('pipeline:query'),
    null,
  );
  const query = useMemo(() => shownPipelineQuery(params, keptQuery), [params, keptQuery]);
  const { stage: queryStage, search, dateWindow, customRange } = query;
  // Patches compose through a ref: the sort control's Apply sets the range and
  // the window back to back, before the URL re-renders the page.
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const updateQuery = useCallback(
    (patch: Partial<PipelineQuery>): void => {
      const next = { ...latestQuery.current, ...patch };
      latestQuery.current = next;
      setKeptQuery({ ...next, search: '' });
      setParams(pipelineQueryParams(next, INITIAL_STAGE), { replace: true });
    },
    [setParams, setKeptQuery],
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

  // A tab return paints the posts this session last read or wrote
  // (src/lib/pipeline-posts.ts) on the first render, at any age, then the
  // mount refreshes them quietly. Only the first visit shows the skeleton.
  const [kept] = useState(() => {
    if (workspaceId === null || userId === null) return undefined;
    const last = keptPipelinePosts(userId, workspaceId);
    // Seed the cover store from the same rows before the cards render.
    if (last !== undefined) primeCovers(workspaceId, listedCovers(last));
    if (last !== undefined) mark('pipeline:kept-paint');
    if (last !== undefined) mark('post:close:board-paint');
    return last;
  });
  // Whether the person has acted on the board since it mounted: a quiet
  // refresh lands only while they have not.
  const untouched = useUntouched();
  const [posts, setPosts] = useState<PipelinePost[]>(() => kept ?? []);
  // The workspace `posts` was read for. A switch renders nothing of the old
  // list: until the new read lands the board shows the skeleton.
  const [loadedFor, setLoadedFor] = useState<string | null>(() =>
    kept !== undefined ? workspaceId : null,
  );
  const loadedForRef = useRef<string | null>(kept !== undefined ? workspaceId : null);
  const loadSeq = useRef(0);
  // True from the first render so the empty pipeline never flashes before the
  // read (false only when the kept posts painted).
  const [postsLoading, setPostsLoading] = useState(kept === undefined);
  // A failed read: the plain LoadError shows; the raw message never reaches the UI.
  const [postsFailed, setPostsFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [movePostTarget, setMovePostTarget] = useState<PipelinePost | null>(null);
  // The select bar's Approve row: the move sheet opens on its approve confirm.
  const [moveIntent, setMoveIntent] = useState<Stage | null>(null);
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
  // filters the select bar's moves and the move sheet.
  const [role, setRole] = useState<string | null>(null);
  // Where the role read stands: the move sheet waits while 'loading' and
  // offers Retry on 'error' instead of blaming the role.
  const [roleStatus, setRoleStatus] = useState<RoleStatus>('loading');
  const [roleAttempt, setRoleAttempt] = useState(0);
  const retryRole = useCallback((): void => setRoleAttempt((n) => n + 1), []);
  // Clients never see Draft: a ?stage=draft link opens Review for them.
  const stage = visibleStage(queryStage, role);
  // Per-post in-flight guard for the move handler (a ref so a re-render never
  // resets it mid-flight); shared by every move path.
  const inFlight = useRef<Set<string>>(new Set());

  // One presign cache for the whole board: it bounds concurrency and caches
  // URLs so every card shares a single cap, mirroring AssetsPage. Cards
  // lazy-resolve their own thumbnail via useInView; the page adds no fetches.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();

  // One fetch for the whole board (no N+1): listPosts once, grouped in memory.
  // A read that lands after a newer one started (a workspace switch) is dropped.
  // The mount (`join`) joins a fresh kept read or the one a nav press started;
  // when the kept posts already painted it is a quiet refresh: no skeleton, a
  // failure keeps the kept view, and it lands only while the board is
  // untouched. Every other load (a create, Retry, a data change) marks the
  // kept read stale and asks the server.
  const loadPosts = useCallback(
    async (join = false) => {
      if (workspaceId === null) return;
      const seq = ++loadSeq.current;
      if (userId !== null && !join) stalePipelinePosts(userId, workspaceId);
      const quiet = join && loadedForRef.current === workspaceId;
      let ok = false;
      let data: PipelinePost[] = [];
      if (!quiet) setPostsLoading(true);
      // One trace id per load, sent as posts_list's p_trace_id.
      const traceId = generateTraceId();
      try {
        mark('pipeline:posts:start');
        const result =
          userId === null
            ? await listPosts(supabase, { workspaceId, limit: PIPELINE_POSTS_LIMIT, traceId })
            : await readPipelinePosts(supabase, userId, workspaceId, listPosts, traceId);
        if (result.ok) {
          ok = true;
          data = result.data;
        }
      } catch {
        // A transport throw (offline) is the same plain failure as an error Result.
      }
      mark('pipeline:posts:end');
      if (seq !== loadSeq.current) return;
      // The kept view stays through a failed or late quiet refresh; the read
      // that landed is kept for the next visit (src/lib/session-read.ts).
      if (quiet && (!ok || !untouched())) return;
      // Seed the cover store from the same posts_list call before the cards
      // render, so the board never reads asset_attachments for these posts.
      if (ok) primeCovers(workspaceId, listedCovers(data));
      if (ok) setPosts(data);
      else if (loadedForRef.current !== workspaceId) setPosts([]);
      loadedForRef.current = workspaceId;
      setLoadedFor(workspaceId);
      setPostsFailed(!ok);
      setPostsLoading(false);
      mark('pipeline:posts:applied');
    },
    [workspaceId, userId, untouched],
  );

  // A workspace switch closes the sheets on the old workspace's posts.
  useEffect(() => {
    setMovePostTarget(null);
    setConfirmMove(null);
  }, [workspaceId]);

  useEffect(() => {
    mark('pipeline:mount');
    void loadPosts(true);
  }, [loadPosts]);
  // The sample week landing or clearing under the board: re-read it.
  useWorkspaceDataChanged(() => void loadPosts());
  // Opening a post from the board leaves for a page that can change it (stage,
  // dates, files) without a post-changed event, so the kept read is marked
  // stale: Back to the board paints it and refreshes it quietly.
  useEffect(() => {
    if (workspaceId === null || userId === null) return;
    return () => {
      if (leavingToPost(window.location.pathname)) stalePipelinePosts(userId, workspaceId);
    };
  }, [workspaceId, userId]);
  // The board's own writes (an optimistic move, its Undo, a failed send put
  // back) replace the kept posts with what the board now shows, for this
  // workspace's posts only. primeRead is idempotent, so the updater stays safe
  // to run twice.
  const setPostsAndKeep = useCallback(
    (updater: (prev: PipelinePost[]) => PipelinePost[]): void => {
      setPosts((prev) => {
        const next = updater(prev);
        if (workspaceId !== null && userId !== null && loadedForRef.current === workspaceId) {
          primePipelinePosts(userId, workspaceId, next);
        }
        return next;
      });
    },
    [workspaceId, userId],
  );
  // A move that landed tells every other surface that keeps this post (chat
  // cards, the Plan tab) through the existing post-changed event.
  const landed = useCallback((postId: string): void => {
    dispatchPostChanged(window, postId);
  }, []);
  // Only the active workspace's posts ever render.
  const live = workspaceId !== null && loadedFor === workspaceId;
  const shownPosts = live ? posts : NO_POSTS;

  // The approvers' names (card status, Send for review helper), every
  // member's name (the creator in the reject confirm) and the on-behalf
  // approvers: ONE membership + profile read for the whole page, handed to the
  // board and the move sheet so neither runs its own.
  const people = useWorkspacePeople(workspaceId);

  useEffect(() => {
    if (workspaceId === null || userId === null) {
      setRole(null);
      setRoleStatus('loading');
      return;
    }
    let cancelled = false;
    setRoleStatus('loading');
    mark('pipeline:role:start');
    void readMemberRole(supabase, workspaceId, userId).then((read) => {
      mark('pipeline:role:end');
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

  // Search runs on the server (posts_search, src/lib/search/server-search.ts):
  // from 2 characters, 250ms after the last keystroke, a newer query aborting
  // the one in flight; under 2 characters the board is the normal list. The
  // search covers every stage, so each chip's count is its matches and the
  // chip still filters them; the date window and the sort below apply as
  // before. A result also on the board shows the board's copy, so an
  // optimistic move lands in the right column. Sort is pure, derived in
  // memory: the date window (undated posts kept once "Show them" is tapped for
  // this window), then order, then group into columns. groupByStage is generic
  // over the element type, so it preserves PipelinePost with no assertion.
  const postSearch = useServerSearch<PipelinePost[]>(
    search,
    (q, signal) =>
      workspaceId === null
        ? Promise.resolve({ ok: true as const, data: [] })
        : searchPipelinePosts(supabase, { workspaceId, query: q }, signal),
    workspaceId ?? '',
  );
  const searchActive = postSearch.active;
  const searchPending = searchActive && postSearch.data === null && postSearch.status !== 'error';
  const dateKey = `${dateWindow}:${customRange?.start ?? ''}:${customRange?.end ?? ''}`;
  const includeUndated = undatedShownFor === dateKey;
  const searched = useMemo(() => {
    if (!searchActive) return shownPosts;
    const onBoard = new Map(shownPosts.map((post) => [post.id, post]));
    return (postSearch.data ?? []).map((post) => onBoard.get(post.id) ?? post);
  }, [shownPosts, searchActive, postSearch.data]);
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
  const narrowed = searchActive || dateFilterActive(query);
  const countLabel = headerCountLabel(visibleCount, inStage(shownPosts).length, true);
  const showFilteredEmpty = narrowed && visibleCount === 0 && !searchPending;
  // Undated posts the date window hides on this chip (after the search).
  const hiddenUndated =
    dateFilterActive(query) && !includeUndated ? inStage(searched).filter(isUndated).length : 0;

  // Card covers (first photo or video with its stored size) for the platform
  // frame, served by the chat cover store; cached on the device. The one
  // posts_list call already returned them and loadPosts seeded the store, so
  // only a row that came without a cover (none today) is read here, in batches.
  // The key is the id SET (sorted), not the display order, so a re-sort or an
  // optimistic stage move never re-runs the request loop; only a different set
  // of posts (a load, a search) asks again, and the store skips ids it holds.
  const covers = usePostCovers(NO_IDS);
  const coverKey = useMemo(
    () => coverIdsKey(sorted.filter((post) => post.firstMedia === undefined)),
    [sorted],
  );
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

  // Single source for the move: the move sheet and the select bar's move rows call this. Every move flips at once and sends after the "Moved to {Stage}" Undo
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
          setPosts: setPostsAndKeep,
          onLanded: landed,
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
    [posts, push, role, runUndoable, workspaceId, setPostsAndKeep, landed],
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
  // Move on a card this viewer cannot move does nothing.
  // A select bar move row passes its target: Approve opens the move sheet straight on
  // its approve confirm, every other target takes the sheet's own path
  // (ask first where it asks). No target (the Move row): the move sheet.
  const openMove = useCallback(
    (post: PipelinePost, to?: Stage): void => {
      if (roleStatus === 'ready' && !hasAllowedMove(role, post.stage as Stage)) return;
      if (to !== undefined && to !== 'approved') {
        requestSheetMove(post.id, to);
        return;
      }
      setMoveIntent(to ?? null);
      setMovePostTarget(post);
    },
    [role, roleStatus, requestSheetMove],
  );
  // Select mode (long-press / right-click on a card): the old ⋮ rows ride the
  // SelectBar. Pure client state; no await or read on the tap path.
  const selection = useListSelection();
  const tickedPost =
    selection.count === 1 ? (shownPosts.find((post) => selection.ids.has(post.id)) ?? null) : null;
  const selectActions = pipelineSelectActions({
    post: tickedPost,
    count: selection.count,
    viewer,
    // Open and the moves leave select mode (its Back entry popped) first, so
    // the page or sheet they open owns the next Back.
    onOpen: (post) => selection.leaveThen(() => openPostCard(navigate, post, workspaceKey)),
    // The copy starts inside the tap (clipboard needs the gesture), then leaves.
    onCopyLink: (post) => {
      void copyText(buildPostLink(window.location.origin, postCardHref(post, workspaceKey))).then(
        (ok) =>
          toastRef.current?.show(
            ok ? { title: 'Link copied' } : { title: COPY_FAILED, tone: 'error' },
          ),
      );
      selection.clear();
    },
    onMove: (post, to) => selection.leaveThen(() => openMove(post, to)),
  });
  const confirmCreator =
    confirmMove === null
      ? null
      : firstNameOf(
          people.names.get(confirmMove.post.owner_user_id ?? confirmMove.post.created_by ?? ''),
        );

  const boardLoading =
    workspaceId === null ||
    !live ||
    (postsLoading && posts.length === 0 && !postsFailed) ||
    searchPending;
  // No posts at all (not a filter hiding them) once a read has succeeded.
  const pipelineEmpty = !boardLoading && !postsFailed && !postsLoading && shownPosts.length === 0;
  // Back on the board, the scroll lands where it was once the posts painted.
  useKeptScroll(viewKey('pipeline:scroll'), !boardLoading && !postsFailed);
  // Boxes show only while nothing is held; the board settles once when it lands
  // after them (never on a kept-view return, which paints the board at once).
  const hadBoxes = useHadBoxes(boardLoading);
  const landRef = useRef<HTMLDivElement>(null);
  useSettleOnLanding(landRef, !boardLoading && !postsFailed, hadBoxes);

  return (
    <>
      <PageHead title="Pipeline" hidden />
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
        <div className={cn('flex flex-col gap-1 pt-3', GUTTER)}>
          <span data-posts-count="" className="text-base text-fg-3">
            {countLabel}
          </span>
          {undatedHint(dateChipLabel(query), hiddenUndated, () => setUndatedShownFor(dateKey))}
        </div>
      ) : null}

      {/* The chips and filters above stay usable through a failed read. */}
      {live && searchActive && postSearch.status === 'error' && postSearch.data === null ? (
        postsLoadError(() => postSearch.refresh(), false)
      ) : live && postsFailed ? (
        postsLoadError(() => void loadPosts(), postsLoading)
      ) : boardLoading ? (
        postsSkeleton()
      ) : pipelineEmpty ? (
        emptyPipeline()
      ) : showFilteredEmpty ? (
        filteredEmpty(searchActive ? query.search : '', dateFilterActive(query), clearFilters)
      ) : (
        <div ref={landRef} className="contents">
          {pipelineSurface({
            stage,
            sorted,
            cache,
            presignEnabled,
            workspaceKey,
            selectFor: selection.selectFor,
            shownKey,
            timeZone,
            viewer,
            covers,
          })}
        </div>
      )}

      {selection.active ? (
        <SelectBar
          label="Selected posts"
          count={selection.count}
          onCancel={selection.clear}
          actions={selectActions}
          data-pipeline-select-bar=""
        />
      ) : null}

      <MoveSheet
        open={movePostTarget !== null}
        post={movePostTarget}
        intent={moveIntent}
        onClose={() => {
          setMovePostTarget(null);
          setMoveIntent(null);
        }}
        onMove={requestSheetMove}
        role={role}
        roleStatus={roleStatus}
        onRetryRole={retryRole}
        approvers={people.approvers}
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
