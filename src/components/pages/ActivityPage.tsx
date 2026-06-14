import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { SortMenu } from '@/components/ui/SortMenu';
import { IconActivity, IconCheck } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import { useSort } from '@/lib/use-sort';
import { inboxMarkAllRead, inboxMarkRead, inboxSnooze } from '@srtdio/rpc';
import { useToasts } from '@/components/pages/assets/useToasts';
import { Toasts } from '@/components/pages/assets/Toasts';
import { ACTIVITY_PAGE_SIZE, listActivity } from './activity/data';
import { filterByScope, filterByState, groupDigest, isCurrentlySnoozed } from './activity/digest';
import { DigestCard } from './activity/DigestCard';
import type { SnoozeKind } from './activity/ActivityRowMenu';
import type { ActivityItem, ActivityScope, ActivityState } from './activity/types';

const STATE_CHIPS: { key: ActivityState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'snoozed', label: 'Snoozed' },
];

const SCOPE_CHIPS: { key: ActivityScope; label: string }[] = [
  { key: 'everything', label: 'Everything' },
  { key: 'posts', label: 'Posts' },
  { key: 'briefs', label: 'Briefs' },
  { key: 'people', label: 'People' },
  { key: 'groups', label: 'Groups' },
  { key: 'clients', label: 'Clients' },
];

type ActivitySort = 'newest' | 'oldest';
const SORT_OPTIONS: { value: ActivitySort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

/** Optimistic snoozed_until for a preset; the server is the source of truth. */
function snoozeUntilIso(kind: SnoozeKind, nowMs: number): string {
  if (kind === '1h') return new Date(nowMs + 3_600_000).toISOString();
  if (kind === '4h') return new Date(nowMs + 14_400_000).toISOString();
  const date = new Date(nowMs);
  date.setDate(date.getDate() + (kind === 'tomorrow_9' ? 1 : 7));
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

export function ActivityPage() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const { value: sort, setValue: setSort } = useSort<ActivitySort>('activity', 'newest');
  const { toasts, push, dismiss } = useToasts();

  const [state, setState] = useState<ActivityState>('all');
  const [scope, setScope] = useState<ActivityScope>('everything');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadActivity = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const result = await listActivity(supabase, { workspaceId });
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setItems(result.data);
    setHasMore(result.data.length === ACTIVITY_PAGE_SIZE);
  }, [workspaceId]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  // Patch a set of items in place (the one optimistic-update primitive).
  function patchItems(ids: Set<string>, patch: Partial<ActivityItem>): void {
    setItems((prev) => prev.map((item) => (ids.has(item.id) ? { ...item, ...patch } : item)));
  }

  async function markRead(item: ActivityItem): Promise<void> {
    if (workspaceId === null || item.readAt !== null) return;
    const ids = new Set([item.id]);
    patchItems(ids, { readAt: new Date().toISOString() });
    const result = await inboxMarkRead(supabase, {
      p_entry_id: item.id,
      p_workspace_id: workspaceId,
      p_created_at: item.createdAt,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      patchItems(ids, { readAt: null });
      push(result.error.message);
    }
  }

  async function snooze(item: ActivityItem, kind: SnoozeKind): Promise<void> {
    if (workspaceId === null) return;
    const ids = new Set([item.id]);
    const previous = item.snoozedUntil;
    patchItems(ids, { snoozedUntil: snoozeUntilIso(kind, Date.now()) });
    const result = await inboxSnooze(supabase, {
      p_entry_id: item.id,
      p_workspace_id: workspaceId,
      p_created_at: item.createdAt,
      p_kind: kind,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      patchItems(ids, { snoozedUntil: previous });
      push(result.error.message);
    }
  }

  async function unsnooze(item: ActivityItem): Promise<void> {
    if (workspaceId === null) return;
    const ids = new Set([item.id]);
    const previous = item.snoozedUntil;
    patchItems(ids, { snoozedUntil: null });
    const result = await inboxSnooze(supabase, {
      p_entry_id: item.id,
      p_workspace_id: workspaceId,
      p_created_at: item.createdAt,
      p_kind: 'clear',
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      patchItems(ids, { snoozedUntil: previous });
      push(result.error.message);
    }
  }

  async function markAllRead(): Promise<void> {
    if (workspaceId === null) return;
    const nowMs = Date.now();
    const affected = items.filter(
      (item) => item.readAt === null && !isCurrentlySnoozed(item, nowMs),
    );
    if (affected.length === 0) return;
    const ids = new Set(affected.map((item) => item.id));
    patchItems(ids, { readAt: new Date().toISOString() });
    const result = await inboxMarkAllRead(supabase, {
      p_workspace_id: workspaceId,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      patchItems(ids, { readAt: null });
      push(result.error.message);
    }
  }

  function openItem(item: ActivityItem): void {
    if (item.entityId === null) return;
    if (item.entityType === 'post') navigate(`/posts/${item.entityId}`);
    else if (item.entityType === 'brief') navigate(`/briefs/${item.entityId}`);
  }

  // Body click: optimistically mark every unread entry read, then navigate.
  function activate(group: ActivityItem[]): void {
    const latest = group[0];
    if (latest === undefined) return;
    const unread = group.filter((item) => item.readAt === null);
    if (unread.length > 0 && workspaceId !== null) {
      patchItems(new Set(unread.map((item) => item.id)), { readAt: new Date().toISOString() });
      void Promise.all(
        unread.map(async (item) => {
          const result = await inboxMarkRead(supabase, {
            p_entry_id: item.id,
            p_workspace_id: workspaceId,
            p_created_at: item.createdAt,
            p_trace_id: newTrace(),
          });
          if (!result.ok) {
            patchItems(new Set([item.id]), { readAt: null });
            push(result.error.message);
          }
        }),
      );
    }
    openItem(latest);
  }

  async function loadMore(): Promise<void> {
    if (workspaceId === null) return;
    const oldest = items[items.length - 1];
    if (oldest === undefined) return;
    setLoadingMore(true);
    const result = await listActivity(supabase, { workspaceId, before: oldest.createdAt });
    setLoadingMore(false);
    if (!result.ok) {
      push(result.error.message);
      return;
    }
    setItems((prev) => [...prev, ...result.data]);
    setHasMore(result.data.length === ACTIVITY_PAGE_SIZE);
  }

  const nowMs = Date.now();
  const unreadCount = useMemo(
    () => items.filter((item) => item.readAt === null && !isCurrentlySnoozed(item, nowMs)).length,
    [items, nowMs],
  );
  const visible = useMemo(
    () => filterByScope(filterByState(items, state, nowMs), scope),
    [items, state, scope, nowMs],
  );
  const digest = useMemo(() => {
    const grouped = groupDigest(visible, nowMs);
    if (sort === 'newest') return grouped;
    return [...grouped].reverse().map((bucket) => ({
      bucket: bucket.bucket,
      groups: [...bucket.groups].reverse().map((group) => [...group].reverse()),
    }));
  }, [visible, sort, nowMs]);

  const listLoading = workspaceId === null || (loading && items.length === 0);

  const actions = (
    <>
      {unreadCount > 0 ? (
        <button
          type="button"
          onClick={() => void markAllRead()}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg md:h-9"
        >
          <IconCheck size={16} />
          <span className="hidden sm:inline">Mark all read</span>
        </button>
      ) : null}
      <SortMenu<ActivitySort> options={SORT_OPTIONS} value={sort} onChange={setSort} />
    </>
  );

  return (
    <>
      <PageHead title="Activity" actions={actions} />

      <div className="px-4 md:px-6 pt-3 flex flex-wrap gap-2">
        {STATE_CHIPS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            size="tap"
            selected={state === item.key}
            onClick={() => setState(item.key)}
          />
        ))}
      </div>

      <div className="px-4 md:px-6 mt-2 flex flex-wrap gap-2">
        {SCOPE_CHIPS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            size="tap"
            selected={scope === item.key}
            onClick={() => setScope(item.key)}
          />
        ))}
      </div>

      {error !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load activity. {error}
          </div>
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading</div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<IconActivity size={24} />}
          title="You are all caught up"
          description="Activity across posts, briefs and people will appear here."
        />
      ) : (
        <div className="px-4 md:px-6 py-4 flex flex-col gap-5">
          {digest.map((bucket) => (
            <div key={bucket.bucket} className="flex flex-col gap-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                {bucket.bucket}
              </h2>
              {bucket.groups.map((group) => (
                <DigestCard
                  key={group[0]?.id ?? bucket.bucket}
                  group={group}
                  nowMs={nowMs}
                  onActivate={() => activate(group)}
                  onMarkRead={(item) => void markRead(item)}
                  onSnooze={(item, kind) => void snooze(item, kind)}
                  onUnsnooze={(item) => void unsnooze(item)}
                  onOpen={openItem}
                />
              ))}
            </div>
          ))}
          {hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="mx-auto inline-flex min-h-[44px] items-center rounded-md border border-border bg-panel px-4 text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"
            >
              {loadingMore ? 'Loading' : 'Load more'}
            </button>
          ) : null}
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
