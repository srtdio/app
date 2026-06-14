import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { IconCheck, IconPlus, IconX } from '@/components/ui/icons';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { MoveSheet } from '@/components/pages/pipeline/MoveSheet';
import { BOARD_CAP, stageLabel } from '@/components/pages/pipeline/stage-meta';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { dispatchSorted } from '@/lib/events';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useMediaQuery } from '@/lib/use-media-query';
import { useSort } from '@/lib/use-sort';
import {
  DATE_SORT_DEFAULT,
  DATE_SORT_OPTIONS,
  filterByTitle,
  sortByDate,
  type DateSort,
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

// The app's md breakpoint: kanban at >=768px, the stacked tab feed below it.
const DESKTOP_QUERY = '(min-width: 768px)';

interface PipelineHeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  sort: DateSort;
  onSortChange: (value: DateSort) => void;
  stage: string;
  onStageChange: (key: string) => void;
  /** Per-tab post counts keyed by tab ('all' plus each Stage), shown as badges. */
  counts: Record<string, number>;
}

/**
 * The Pipeline header chrome: the shared SectionHeader (search, sort, accent "+"
 * create) with the stage tabs in the filter-chips slot. Each tab carries its
 * post count as a trailing badge in the label (the Tabs primitive renders a
 * label, reused unchanged). Pure (no hooks) so the wiring is unit-tested by
 * walking the returned tree, mirroring SectionHeader's own tests; the page owns
 * the state and re-fetch.
 */
export function pipelineHeader(props: PipelineHeaderProps): ReactElement {
  const tabs: TabItem[] = [
    { key: 'all', label: `All ${props.counts.all ?? 0}` },
    ...STAGES.map((stage) => ({
      key: stage,
      label: `${stageLabel(stage)} ${props.counts[stage] ?? 0}`,
    })),
  ];
  return (
    <SectionHeader<DateSort>
      search={{ value: props.search, onChange: props.onSearchChange, placeholder: 'Search posts' }}
      sort={{ options: DATE_SORT_OPTIONS, value: props.sort, onChange: props.onSortChange }}
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
      <Tabs items={tabs} active={props.stage} onChange={props.onStageChange} />
    </SectionHeader>
  );
}

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
      return 'Could not move the post. Please try again.';
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
  const { workspaceId } = useWorkspace();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [stage, setStage] = useState('all');
  const [search, setSearch] = useState('');
  const { value: sort, setValue: setSort } = useSort<DateSort>('pipeline', DATE_SORT_DEFAULT);
  const [cardDismissed, setCardDismissed] = useState(false);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});

  const [posts, setPosts] = useState<PipelinePost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [movePostTarget, setMovePostTarget] = useState<PipelinePost | null>(null);
  const { toasts, push, dismiss } = useToasts();
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
  // whole board), so no refetch and no N+1: filter by title, then order, then
  // group into columns. groupByStage is generic over the element type, so it
  // preserves PipelinePost (thumbnailAssetVersionId and all) with no assertion.
  const grouped = useMemo(
    () => groupByStage(sortByDate(filterByTitle(posts, search), sort), STAGES),
    [posts, search, sort],
  );

  // Per-tab counts over the filtered list: each stage plus the 'all' total.
  const counts = useMemo(() => stageCounts(grouped, STAGES), [grouped]);

  // Single source for the move: both the desktop drop and the mobile sheet call
  // this, which awaits the proc then re-groups on success (see runMovePost).
  const movePost = useCallback(
    (postId: string, toStage: Stage): void => {
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
      );
    },
    [posts, push],
  );

  const visibleStages = stageColumns(STAGES, stage);

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
  const showCard = !cardDismissed && visibleSteps.length > 0;

  const boardLoading = workspaceId === null || (postsLoading && posts.length === 0);

  return (
    <>
      {pipelineHeader({
        search,
        onSearchChange: setSearch,
        sort,
        onSortChange: setSort,
        stage,
        onStageChange: setStage,
        counts,
      })}

      {/* Honest counter: the FILTERED total (counts.all, summed from the same
          grouped list the board/feed render), so it tracks the active search
          instead of freezing at the unfiltered posts.length. */}
      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">{postCountLabel(counts.all ?? 0)}</div>

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
      ) : isDesktop ? (
        <PipelineBoard
          stages={visibleStages}
          grouped={grouped}
          cap={stage === 'all' ? BOARD_CAP : null}
          cache={cache}
          presignEnabled={presignEnabled}
          onViewAll={setStage}
          onMovePost={movePost}
        />
      ) : (
        <PipelineFeed
          stages={STAGES}
          grouped={grouped}
          activeStage={stage}
          cache={cache}
          presignEnabled={presignEnabled}
          onViewAll={setStage}
          onLongPressPost={setMovePostTarget}
        />
      )}

      <MoveSheet
        open={movePostTarget !== null}
        post={movePostTarget}
        onClose={() => setMovePostTarget(null)}
        onMove={movePost}
      />

      <CreatePostSheet
        open={createOpen}
        workspaceId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void loadPosts();
        }}
      />

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
