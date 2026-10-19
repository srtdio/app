import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { IconActivity, IconAlarmClock, IconAt, IconBriefs } from '@/components/ui/icons';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { ActivityFilterBar } from '@/components/pages/activity/ActivityFilterBar';
import { AvatarStack } from '@/components/pages/activity/AvatarStack';
import { mentionHandle } from '@/lib/chat/mentions';
import {
  ACTIVITY_PAGE_SIZE,
  bucketActorNames,
  entityHref,
  fetchActivityEntries,
  filterByState,
  groupDigest,
  ACTIVITY_LOAD_FAILED,
  MARKED_READ_LABEL,
  markAllTargets,
  markAllEntriesRead,
  markEntryRead,
  snoozeEntry,
  unreadCount,
  type ActivityDirection,
  type ActivityItem,
  type ActivityState,
  type SnoozeKind,
} from '@/components/pages/activity/data';
import { fetchUnreadMentionCount } from '@/lib/inbox/inbox-reads';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { useCurrentProfile } from '@/lib/use-current-profile';
import { useWorkspace } from '@/lib/workspace-context';
import { useSort } from '@/lib/use-sort';
import { PresignCache } from '@/lib/asset-presign';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { INDUCTION_KEYS } from '@/lib/induction';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { useOptionalToast } from '@/components/ui/toast';
import { undoFailureTitle } from '@/lib/use-undoable-action';

/** Fixed failure copy for Mark all read: "Couldn't mark as read. Try again." */
const MARK_READ_FAILED = undoFailureTitle(MARKED_READ_LABEL);

const SORT_OPTIONS: SortOption<ActivityDirection>[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

/** Optimistic snoozed_until for a kind; the proc returns the authoritative value
 * (workspace timezone), this only flips the row's local state until it lands. */
function optimisticSnoozeUntil(kind: SnoozeKind, nowMs: number): string | null {
  switch (kind) {
    case '1h':
      return new Date(nowMs + 3_600_000).toISOString();
    case '4h':
      return new Date(nowMs + 4 * 3_600_000).toISOString();
    case 'tomorrow_9':
      return new Date(nowMs + 86_400_000).toISOString();
    case 'next_week':
      return new Date(nowMs + 7 * 86_400_000).toISOString();
    case 'clear':
      return null;
  }
}

export function ActivityPage() {
  const navigate = useNavigate();
  const { workspaceId, workspaceKey } = useWorkspace();
  const newTrace = useNewTrace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const { profile } = useCurrentProfile();
  // Mentions render @username, so my own accent matches my handle (name when none).
  const selfName =
    profile != null
      ? mentionHandle({ displayName: profile.display_name, username: profile.username })
      : null;

  const [state, setState] = useState<ActivityState>('all');
  const { value: sort, setValue: setSort } = useSort<ActivityDirection>('activity', 'newest');

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [mentionCount, setMentionCount] = useState(0);
  const { toasts, push, dismiss } = useToasts();
  const toast = useOptionalToast();

  // One presign cache for the whole feed: it bounds concurrency and caches URLs
  // so every card thumbnail shares a single cap, mirroring PipelinePage. Cards
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

  // Load page one for the active chip. Every chip filters server-side (All has
  // no filter), so older matches are never hidden behind the newest-page cap.
  // `state` is a dependency: switching chips replaces `items` wholesale, which
  // resets pagination (the keyset cursor lives in the loaded rows).
  const loadActivity = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(false);
    const result = await fetchActivityEntries(supabase, workspaceId, { state });
    setLoading(false);
    setNowMs(Date.now());
    if (!result.ok) {
      setError(true);
      return;
    }
    setItems(result.data);
    setHasMore(result.data.length === ACTIVITY_PAGE_SIZE);
  }, [workspaceId, state]);

  // Fetch the next, older page (rows strictly before the oldest loaded created_at)
  // and append it, re-running enrichment for just the new rows. The active chip
  // is carried so pagination stays within its filter.
  const loadMore = useCallback(async () => {
    if (workspaceId === null) return;
    const oldest = items[items.length - 1]?.createdAt;
    if (oldest === undefined) return;
    setLoadingMore(true);
    const result = await fetchActivityEntries(supabase, workspaceId, { before: oldest, state });
    setLoadingMore(false);
    if (!result.ok) {
      push('Could not load more activity');
      return;
    }
    setItems((prev) => [...prev, ...result.data]);
    setHasMore(result.data.length === ACTIVITY_PAGE_SIZE);
  }, [workspaceId, state, items, push]);

  // The unread-mention count for the Mentions chip. Independent of the active
  // view (it is a HEAD count), so it is not affected by the chips.
  const loadMentionCount = useCallback(async () => {
    if (workspaceId === null || userId === null) return;
    const res = await fetchUnreadMentionCount(supabase, {
      workspaceId,
      userId,
      nowIso: new Date().toISOString(),
    });
    if (res.ok) setMentionCount(res.data);
  }, [workspaceId, userId]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    void loadMentionCount();
  }, [loadMentionCount]);
  useWorkspaceDataChanged(() => {
    void loadActivity();
    void loadMentionCount();
  });

  // Reset filters when the active workspace changes.
  useEffect(() => {
    setState('all');
  }, [workspaceId]);

  const buckets = useMemo(
    () => groupDigest(filterByState(items, state, nowMs), sort),
    [items, state, sort, nowMs],
  );

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

  // Open a thread: mark only the lead entry read (optimistic) and navigate from
  // it. The rest stay unread, so the card stays highlighted until they are seen.
  const handleOpenGroup = useCallback(
    (group: ActivityItem[]) => {
      if (workspaceId === null) return;
      const lead = group[0];
      if (lead === undefined) return;
      if (lead.readAt === null) {
        markReadLocal(lead.id);
        void markEntryRead(supabase, lead, workspaceId, newTrace());
      }
      const href = entityHref(lead, workspaceKey);
      if (href !== null) navigate(href);
    },
    [workspaceId, workspaceKey, newTrace, navigate, markReadLocal],
  );

  // Open a single thread entry: mark just that entry read (optimistic) and
  // navigate from it, mirroring handleOpenGroup for one entry.
  const handleOpenEntry = useCallback(
    (entry: ActivityItem) => {
      if (workspaceId === null) return;
      if (entry.readAt === null) {
        markReadLocal(entry.id);
        void markEntryRead(supabase, entry, workspaceId, newTrace());
      }
      const href = entityHref(entry, workspaceKey);
      if (href !== null) navigate(href);
    },
    [workspaceId, workspaceKey, newTrace, navigate, markReadLocal],
  );

  const handleMarkRead = useCallback(
    (item: ActivityItem) => {
      if (workspaceId === null || item.readAt !== null) return;
      markReadLocal(item.id);
      void markEntryRead(supabase, item, workspaceId, newTrace()).then((result) => {
        if (!result.ok) {
          push('Could not mark as read');
          void loadActivity();
          return;
        }
        void loadMentionCount();
        window.dispatchEvent(new CustomEvent('sorted:inbox-changed'));
      });
    },
    [workspaceId, newTrace, markReadLocal, push, loadActivity, loadMentionCount],
  );

  // The active chip only: mark its unread, non-snoozed rows read at once and
  // write immediately; no Undo. A plain "Marked as read" toast confirms; on
  // failure the rows go back to unread with a fixed error toast.
  // The All chip uses the workspace-wide proc (matches inbox_mark_all_read).
  const handleMarkAll = useCallback(() => {
    if (workspaceId === null) return;
    const targets = markAllTargets(items, state, nowMs);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((item) => item.id));
    const stamp = new Date().toISOString();
    const chip = state;
    setItems((prev) => prev.map((item) => (ids.has(item.id) ? { ...item, readAt: stamp } : item)));
    toast?.show({ title: MARKED_READ_LABEL });
    const traceId = newTrace();
    void (async () => {
      const results =
        chip === 'all'
          ? [await markAllEntriesRead(supabase, workspaceId, traceId)]
          : await Promise.all(
              targets.map((item) => markEntryRead(supabase, item, workspaceId, traceId)),
            );
      if (results.some((result) => !result.ok)) {
        setItems((prev) =>
          prev.map((item) =>
            ids.has(item.id) && item.readAt === stamp ? { ...item, readAt: null } : item,
          ),
        );
        toast?.show({ title: MARK_READ_FAILED });
        return;
      }
      void loadMentionCount();
      window.dispatchEvent(new CustomEvent('sorted:inbox-changed'));
    })();
  }, [workspaceId, items, state, nowMs, newTrace, toast, loadMentionCount]);

  const chipUnread = useMemo(
    () => markAllTargets(items, state, nowMs).length,
    [items, state, nowMs],
  );

  // Optimistic snooze: flip the row's snoozed_until locally first, then call the
  // proc; on failure revert and surface the error (matches handleMarkRead).
  const handleSnooze = useCallback(
    (item: ActivityItem, kind: SnoozeKind) => {
      if (workspaceId === null) return;
      const previous = item.snoozedUntil;
      const next = optimisticSnoozeUntil(kind, Date.now());
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, snoozedUntil: next } : i)));
      void snoozeEntry(supabase, item, workspaceId, kind, newTrace()).then((result) => {
        if (!result.ok) {
          setItems((prev) =>
            prev.map((i) => (i.id === item.id ? { ...i, snoozedUntil: previous } : i)),
          );
          push(result.error.message);
          return;
        }
        window.dispatchEvent(new CustomEvent('sorted:inbox-changed'));
      });
    },
    [workspaceId, newTrace, push],
  );

  const listLoading = workspaceId === null || (loading && items.length === 0);

  return (
    <>
      <PageHead
        title="Activity"
        actions={
          <>
            {chipUnread > 0 ? (
              <Button variant="ghost" size="lg" onClick={handleMarkAll}>
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

      <ActivityFilterBar
        state={state}
        onStateChange={setState}
        totalUnread={totalUnread}
        mentionCount={mentionCount}
      />

      {error ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            {ACTIVITY_LOAD_FAILED}
          </div>
          <div className="mt-3">
            <Button size="lg" onClick={() => void loadActivity()}>
              Retry
            </Button>
          </div>
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading activity</div>
      ) : buckets.length === 0 ? (
        state === 'mentions' ? (
          <EmptyState
            icon={<IconAt size={24} />}
            title="No mentions yet"
            description="When someone types @ and your name in a comment, it lands here."
          />
        ) : state === 'briefs' ? (
          <EmptyState
            icon={<IconBriefs size={24} />}
            title="No brief activity yet"
            description="Briefs created or closed, brief comments and posts made from a brief will appear here."
          />
        ) : state === 'snoozed' ? (
          <EmptyState
            icon={<IconAlarmClock size={24} />}
            title="Nothing snoozed"
            description="Snoozed items wait here and come back on their own."
          />
        ) : (
          <EmptyState
            icon={<IconActivity size={24} />}
            title="You are all caught up"
            description="Activity across posts, briefs and people will appear here."
          />
        )
      ) : (
        <div className="pb-6">
          {buckets.map((bucket, bucketIndex) => {
            const entries = bucket.groups.flat();
            return (
              <section key={bucket.key} className="mt-4">
                <div className="flex items-center gap-2.5 px-4 md:px-6">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                    {bucket.label}
                  </h2>
                  <AvatarStack names={bucketActorNames(entries)} />
                  <span className="ml-auto text-xs text-fg-3">{entries.length}</span>
                </div>
                <div className="mt-2 flex flex-col gap-2 px-4 md:px-6">
                  {bucket.groups.map((group, groupIndex) => {
                    const card = (
                      <ActivityCard
                        key={group[0]?.id ?? bucket.key}
                        group={group}
                        nowMs={nowMs}
                        cache={cache}
                        presignEnabled={presignEnabled}
                        onOpenGroup={handleOpenGroup}
                        onOpenEntry={handleOpenEntry}
                        onSnooze={handleSnooze}
                        onMarkRead={handleMarkRead}
                        selfName={selfName}
                      />
                    );
                    // The newest card is what the induction points at (its own corners, not the padded list).
                    return bucketIndex === 0 && groupIndex === 0 ? (
                      <div
                        key={group[0]?.id ?? bucket.key}
                        data-induction={INDUCTION_KEYS.activityList}
                        className="rounded-xl"
                      >
                        {card}
                      </div>
                    ) : (
                      card
                    );
                  })}
                </div>
              </section>
            );
          })}

          {hasMore ? (
            <div className="mt-4 flex justify-center px-4 md:px-6">
              <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
