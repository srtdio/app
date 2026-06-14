import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { IconActivity } from '@/components/ui/icons';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { ActivityRow } from '@/components/pages/activity/ActivityRow';
import { AvatarStack } from '@/components/pages/activity/AvatarStack';
import {
  bucketActorNames,
  entityHref,
  fetchActivityEntries,
  filterByScope,
  filterByState,
  groupDigest,
  isSnoozed,
  markAllEntriesRead,
  markEntryRead,
  snoozeEntry,
  unreadCount,
  type ActivityDirection,
  type ActivityItem,
  type ActivityScope,
  type ActivityState,
  type SnoozeKind,
} from '@/components/pages/activity/data';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useSort } from '@/lib/use-sort';

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

const SORT_OPTIONS: SortOption<ActivityDirection>[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

export function ActivityPage() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();

  const [state, setState] = useState<ActivityState>('all');
  const [scope, setScope] = useState<ActivityScope>('everything');
  const { value: sort, setValue: setSort } = useSort<ActivityDirection>('activity', 'newest');

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { toasts, push, dismiss } = useToasts();

  const loadActivity = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const result = await fetchActivityEntries(supabase, workspaceId);
    setLoading(false);
    setNowMs(Date.now());
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems(result.data);
  }, [workspaceId]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  // Reset filters when the active workspace changes.
  useEffect(() => {
    setState('all');
    setScope('everything');
  }, [workspaceId]);

  const buckets = useMemo(() => {
    const scoped = filterByScope(items, scope);
    const stated = filterByState(scoped, state, nowMs);
    return groupDigest(stated, sort);
  }, [items, scope, state, sort, nowMs]);

  const totalUnread = useMemo(() => unreadCount(items, nowMs), [items, nowMs]);

  // Mark one entry read in place, optimistically (read-state is best-effort).
  const markReadLocal = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id && item.readAt === null
          ? { ...item, readAt: new Date().toISOString() }
          : item,
      ),
    );
  }, []);

  const handleOpen = useCallback(
    (item: ActivityItem) => {
      if (workspaceId === null) return;
      if (item.readAt === null) {
        markReadLocal(item.id);
        void markEntryRead(supabase, item, workspaceId, newTrace());
      }
      const href = entityHref(item);
      if (href !== null) navigate(href);
    },
    [workspaceId, newTrace, navigate, markReadLocal],
  );

  const handleMarkRead = useCallback(
    (item: ActivityItem) => {
      if (workspaceId === null || item.readAt !== null) return;
      markReadLocal(item.id);
      void markEntryRead(supabase, item, workspaceId, newTrace()).then((result) => {
        if (!result.ok) {
          push('Could not mark as read');
          void loadActivity();
        }
      });
    },
    [workspaceId, newTrace, markReadLocal, push, loadActivity],
  );

  // Workspace-wide: mark every currently-loaded unread, non-snoozed item read,
  // ignoring the active scope / state chips (matches inbox_mark_all_read).
  const handleMarkAll = useCallback(() => {
    if (workspaceId === null) return;
    const hasUnread = items.some((item) => item.readAt === null && !isSnoozed(item, nowMs));
    if (!hasUnread) return;
    const stamp = new Date().toISOString();
    setItems((prev) =>
      prev.map((item) =>
        item.readAt === null && !isSnoozed(item, nowMs) ? { ...item, readAt: stamp } : item,
      ),
    );
    void markAllEntriesRead(supabase, workspaceId, newTrace()).then((result) => {
      if (!result.ok) {
        push('Could not mark all as read');
        void loadActivity();
      }
    });
  }, [workspaceId, items, nowMs, newTrace, push, loadActivity]);

  const handleSnooze = useCallback(
    (item: ActivityItem, kind: SnoozeKind) => {
      if (workspaceId === null) return;
      void snoozeEntry(supabase, item, workspaceId, kind, newTrace()).then((result) => {
        if (!result.ok) {
          push('Could not update snooze');
          return;
        }
        push(kind === 'clear' ? 'Reminder cleared' : 'Snoozed');
        void loadActivity();
      });
    },
    [workspaceId, newTrace, push, loadActivity],
  );

  const listLoading = workspaceId === null || (loading && items.length === 0);

  return (
    <>
      <PageHead
        title="Activity"
        actions={
          <>
            {totalUnread > 0 ? (
              <Button variant="ghost" size="sm" onClick={handleMarkAll}>
                Mark all read
              </Button>
            ) : null}
            <SortMenu<ActivityDirection>
              options={SORT_OPTIONS}
              value={sort}
              onChange={setSort}
              label="Sort activity"
            />
          </>
        }
      />

      <div className="px-4 md:px-6 pt-3 flex flex-wrap gap-2">
        {STATE_CHIPS.map((item) => (
          <Chip
            key={item.key}
            label={item.key === 'unread' && totalUnread > 0 ? `Unread ${totalUnread}` : item.label}
            selected={state === item.key}
            size="tap"
            onClick={() => setState(item.key)}
          />
        ))}
      </div>

      <div className="px-4 md:px-6 mt-2 flex flex-wrap gap-2">
        {SCOPE_CHIPS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            selected={scope === item.key}
            size="tap"
            onClick={() => setScope(item.key)}
          />
        ))}
      </div>

      {error !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load activity. {error}
          </div>
          <div className="mt-3">
            <Button onClick={() => void loadActivity()}>Retry</Button>
          </div>
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading activity</div>
      ) : buckets.length === 0 ? (
        <EmptyState
          icon={<IconActivity size={24} />}
          title="You are all caught up"
          description="Activity across posts, briefs and people will appear here."
        />
      ) : (
        <div className="pb-6">
          {buckets.map((bucket) => (
            <section key={bucket.key} className="mt-4">
              <div className="flex items-center gap-2.5 px-4 md:px-6">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                  {bucket.label}
                </h2>
                <AvatarStack names={bucketActorNames(bucket.items)} />
                <span className="ml-auto text-xs text-fg-3">{bucket.items.length}</span>
              </div>
              <div className="mt-1 divide-y divide-border">
                {bucket.items.map((item) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    nowMs={nowMs}
                    onOpen={handleOpen}
                    onSnooze={handleSnooze}
                    onMarkRead={handleMarkRead}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
