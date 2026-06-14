import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { BOARD_CAP, stageLabel } from '@/components/pages/pipeline/stage-meta';
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
import { listPosts, STAGE_TRANSITIONS } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';
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
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    let total = 0;
    for (const s of STAGES) {
      out[s] = grouped[s].length;
      total += grouped[s].length;
    }
    out.all = total;
    return out;
  }, [grouped]);

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

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">
        {posts.length} {posts.length === 1 ? 'post' : 'posts'}
      </div>

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
        />
      ) : (
        <PipelineFeed
          stages={STAGES}
          grouped={grouped}
          activeStage={stage}
          cache={cache}
          presignEnabled={presignEnabled}
          onViewAll={setStage}
        />
      )}

      <CreatePostSheet
        open={createOpen}
        workspaceId={workspaceId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void loadPosts();
        }}
      />
    </>
  );
}
