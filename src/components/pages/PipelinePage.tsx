import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { PageHead } from '@/components/shell/PageHead';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { IconCheck, IconSort, IconX } from '@/components/ui/icons';
import { PostCard } from '@/components/pages/PostCard';
import { CreatePostSheet } from '@/components/pages/CreatePostSheet';
import { dispatchSorted } from '@/lib/events';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { listPosts, STAGE_TRANSITIONS } from '@srtdio/posts';
import type { Post, Stage } from '@srtdio/posts';

// The board columns are the workflow stages, in transition-map order. Stage
// values come from the @srtdio/posts type, never hardcoded literals in JSX.
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

function stageLabel(stage: Stage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

const STAGE_TABS: TabItem[] = [
  { key: 'all', label: 'All' },
  ...STAGES.map((stage) => ({ key: stage, label: stageLabel(stage) })),
];

interface OnboardingStep {
  key: string;
  label: string;
  action: string;
  run: () => void;
}

export function PipelinePage() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const [stage, setStage] = useState('all');
  const [cardDismissed, setCardDismissed] = useState(false);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});

  const [posts, setPosts] = useState<Post[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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

  const grouped = useMemo(() => {
    const map = Object.fromEntries(STAGES.map((s) => [s, [] as Post[]])) as Record<Stage, Post[]>;
    for (const post of posts) {
      const column = map[post.stage as Stage];
      if (column !== undefined) column.push(post);
    }
    return map;
  }, [posts]);

  const visibleStages = stage === 'all' ? STAGES : STAGES.filter((s) => s === stage);

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
      <PageHead
        title="Pipeline"
        actions={
          <Button>
            <IconSort size={16} />
            Sort
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">
        {posts.length} {posts.length === 1 ? 'post' : 'posts'}
      </div>

      <div className="px-4 md:px-6 mt-2">
        <Tabs items={STAGE_TABS} active={stage} onChange={setStage} />
      </div>

      <div className="px-4 md:px-6 mt-3 flex flex-wrap gap-2">
        <Chip label="+ Owner" variant="add" size="tap" />
        <Chip label="+ Bucket" variant="add" size="tap" />
        <Chip label="+ Date" variant="add" size="tap" />
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
      ) : (
        <div className="px-4 md:px-6 py-4 flex gap-3 overflow-x-auto">
          {visibleStages.map((columnStage) => {
            const columnPosts = grouped[columnStage];
            return (
              <div
                key={columnStage}
                className="flex w-[260px] shrink-0 flex-col rounded-xl border border-border bg-panel-2"
              >
                <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
                  <span className="text-sm font-medium">{stageLabel(columnStage)}</span>
                  <span className="ml-auto text-xs text-fg-3 tabular-nums">
                    {columnPosts.length}
                  </span>
                </div>
                {columnPosts.length === 0 ? (
                  <div className="flex items-center justify-center min-h-[160px] px-3 py-6 text-sm text-fg-3">
                    No posts
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 p-2">
                    {columnPosts.map((post) => (
                      <PostCard key={post.id} post={post} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
