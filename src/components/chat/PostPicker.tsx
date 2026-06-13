// The post picker Sheet, opened by the composer's "Share a post" menu item. It
// reads the workspace's posts through the existing @srtdio/posts RLS select
// (listPostsForPicker, scoped to workspace + stage + a simple title match, no
// full-text index), so a viewer only ever sees posts RLS lets them see. Selection
// is controlled by the composer: toggling a row adds/removes a removable shared
// post chip there. One read per filter change (no N+1 in the list).

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconPipeline, IconSearch } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { listPostsForPicker, type PostCardFields } from '@srtdio/posts';
import {
  DEFAULT_POST_FILTER,
  POST_FILTERS,
  filterStage,
  isPostSelected,
  type PostFilter,
} from '@/components/chat/post-picker';

interface PostPickerProps {
  open: boolean;
  onClose: () => void;
  /** The composer's current shared-post selection (controlled). */
  selected: readonly PostCardFields[];
  /** Toggle one post in/out of the selection (adds/removes its chip). */
  onToggle: (post: PostCardFields) => void;
}

/** Title-case a stage value for its chip (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export function PostPicker(props: PostPickerProps): ReactElement {
  const { workspaceId } = useWorkspace();
  const [filter, setFilter] = useState<PostFilter>(DEFAULT_POST_FILTER);
  const [query, setQuery] = useState('');
  const [posts, setPosts] = useState<PostCardFields[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the default filter and empty search each time the picker opens.
  useEffect(() => {
    if (props.open) {
      setFilter(DEFAULT_POST_FILTER);
      setQuery('');
    }
  }, [props.open]);

  // One RLS-scoped read per (workspace, filter, search) change; never per row.
  useEffect(() => {
    if (!props.open || workspaceId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const stage = filterStage(filter);
    void listPostsForPicker(supabase, {
      workspaceId,
      titleQuery: query,
      ...(stage !== undefined ? { stage } : {}),
    }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error.message);
        setPosts([]);
        return;
      }
      setPosts(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, workspaceId, filter, query]);

  const count = props.selected.length;

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Share a post"
      footer={
        <Button variant="primary" size="lg" className="ml-auto" onClick={props.onClose}>
          {count > 0 ? `Done (${count})` : 'Done'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Search">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
              <IconSearch size={16} />
            </span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search all posts"
              className="pl-9"
            />
          </div>
        </Field>

        <div className="flex flex-wrap gap-2">
          {POST_FILTERS.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              size="tap"
              selected={filter === option.key}
              onClick={() => setFilter(option.key)}
            />
          ))}
        </div>

        <PostPickerList
          posts={posts}
          loading={loading}
          error={error}
          selected={props.selected}
          onToggle={props.onToggle}
        />
      </div>
    </Sheet>
  );
}

function PostPickerList(props: {
  posts: PostCardFields[];
  loading: boolean;
  error: string | null;
  selected: readonly PostCardFields[];
  onToggle: (post: PostCardFields) => void;
}): ReactElement {
  if (props.loading) {
    return <p className="px-1 py-3 text-sm text-fg-3">Loading posts</p>;
  }
  if (props.error !== null) {
    return (
      <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
        {props.error}
      </div>
    );
  }
  if (props.posts.length === 0) {
    return (
      <EmptyState
        icon={<IconPipeline size={22} />}
        title="No posts"
        description="No posts match this filter."
      />
    );
  }
  return (
    <ul className="flex max-h-[50vh] flex-col overflow-y-auto">
      {props.posts.map((post) => {
        const active = isPostSelected(props.selected, post.id);
        return (
          <li key={post.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => props.onToggle(post)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-2 min-h-[44px] text-left transition-colors',
                active ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-panel-2',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{post.title}</span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  <Chip label={post.platform} />
                  <Chip label={post.format} />
                  <Chip label={stageLabel(post.stage)} />
                </span>
              </span>
              {active ? <IconCheck size={18} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
