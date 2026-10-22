import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { PageHead } from '@/components/shell/PageHead';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import {
  IconActivity,
  IconAlarmClock,
  IconAt,
  IconBriefs,
  IconCalendarClock,
  IconPlan,
} from '@/components/ui/icons';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { ActivityCard, UpcomingCard } from '@/components/pages/activity/ActivityCard';
import { ActivityFilterBar } from '@/components/pages/activity/ActivityFilterBar';
import { AvatarStack } from '@/components/pages/activity/AvatarStack';
import { NOTIFICATIONS_TITLE } from '@/components/shell/NotificationsButton';
import { REMINDER_CANCELLED_COPY, createReminderActions } from '@/components/chat/ReminderContext';
import { CANCEL_REMINDER_LABEL, ReminderSheet } from '@/components/chat/ReminderSheet';
import {
  CANCEL_CONFIRM_TITLE,
  DONT_SEND_LABEL,
  ScheduledListSheet,
} from '@/components/chat/ScheduledListSheet';
import { mentionHandle, mentionNamesIn } from '@/lib/chat/mentions';
import { newMessageId } from '@/lib/chat/message-id';
import {
  ACTION_FAILED_COPY,
  REMINDERS_CHANGED_EVENT,
  announceRemindersChanged,
} from '@/lib/chat/reminders';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { logger } from '@/lib/logger';
import {
  ACTIVITY_PAGE_SIZE,
  bucketActorNames,
  createUpcomingScheduledWrites,
  fetchActivityEntries,
  fetchUpcoming,
  filterByState,
  groupDigest,
  upcomingHref,
  ACTIVITY_LOAD_FAILED,
  CANCEL_REMINDER_TITLE,
  MARKED_READ_LABEL,
  UPCOMING_EMPTY,
  markAllTargets,
  markAllEntriesRead,
  markEntryRead,
  openAction,
  retryFailedSend,
  snoozeEntry,
  unreadCount,
  type ActivityDirection,
  type ActivityItem,
  type ActivityState,
  type SnoozeKind,
  type UpcomingItem,
} from '@/components/pages/activity/data';
import { fetchUnreadMentionCount } from '@/lib/inbox/inbox-reads';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { useCurrentProfile } from '@/lib/use-current-profile';
import { useWorkspace } from '@/lib/workspace-context';
import { useSort } from '@/lib/use-sort';
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

/** A load failure: the plain copy and Retry (the feed's and Upcoming's). */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-4 md:px-6 mt-4">
      <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
        {ACTIVITY_LOAD_FAILED}
      </div>
      <div className="mt-3">
        <Button size="lg" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const { workspaceId, workspaceKey } = useWorkspace();
  const newTrace = useNewTrace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const { profile } = useCurrentProfile();
  // A plan_opened alert reads "shared with you" for a client.
  const { side } = useViewerSide(workspaceId);
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
  const cache = appPresignCache();

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

  // Upcoming: the viewer's scheduled messages not yet sent and pending
  // reminders, soonest first (fetchUpcoming). Never inbox rows: they never
  // count toward the unread badge and Mark all read never touches them. A
  // reload that fails keeps the rows on screen; only a first load shows the error.
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [upcomingLoaded, setUpcomingLoaded] = useState(false);
  const [upcomingError, setUpcomingError] = useState(false);
  // Rows a cancel is removing, hidden at once until the reload drops them.
  const [hiddenUpcoming, setHiddenUpcoming] = useState<ReadonlySet<string>>(new Set());
  const upcomingSeqRef = useRef(0);
  const upcomingLoadedRef = useRef(false);
  const loadUpcoming = useCallback(async () => {
    if (workspaceId === null) return;
    upcomingSeqRef.current += 1;
    const seq = upcomingSeqRef.current;
    const result = await fetchUpcoming(supabase, workspaceId);
    if (seq !== upcomingSeqRef.current) return;
    setNowMs(Date.now());
    if (!result.ok) {
      logger.warn('notifications: upcoming load failed', { error: result.error });
      if (!upcomingLoadedRef.current) setUpcomingError(true);
      return;
    }
    upcomingLoadedRef.current = true;
    setUpcomingLoaded(true);
    setUpcomingError(false);
    setUpcoming(result.data);
    const present = new Set(result.data.map((item) => item.id));
    setHiddenUpcoming((prev) => new Set([...prev].filter((id) => present.has(id))));
  }, [workspaceId]);

  useEffect(() => {
    if (state === 'upcoming') void loadUpcoming();
    else void loadActivity();
  }, [state, loadActivity, loadUpcoming]);

  // A reminder set, cancelled or rung anywhere (and the shell's poll tick)
  // reloads Upcoming while it is on screen.
  useEffect(() => {
    if (state !== 'upcoming') return;
    const reload = (): void => void loadUpcoming();
    window.addEventListener(REMINDERS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(REMINDERS_CHANGED_EVENT, reload);
  }, [state, loadUpcoming]);

  useEffect(() => {
    void loadMentionCount();
  }, [loadMentionCount]);
  useWorkspaceDataChanged(() => {
    if (state === 'upcoming') void loadUpcoming();
    else void loadActivity();
    void loadMentionCount();
  });

  // Reset filters (and Upcoming) when the active workspace changes.
  useEffect(() => {
    setState('all');
    upcomingSeqRef.current += 1;
    upcomingLoadedRef.current = false;
    setUpcoming([]);
    setUpcomingLoaded(false);
    setUpcomingError(false);
    setHiddenUpcoming(new Set());
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

  // Open one entry by its tap rule (openAction): mark it read (optimistic)
  // unless it is a reminder, toast a deleted plan, then navigate to its link.
  const handleOpenEntry = useCallback(
    (entry: ActivityItem) => {
      if (workspaceId === null) return;
      const open = openAction(entry, workspaceKey);
      if (open.markRead && entry.readAt === null) {
        markReadLocal(entry.id);
        void markEntryRead(supabase, entry, workspaceId, newTrace());
      }
      if (open.toast !== null) toast?.show({ title: open.toast });
      if (open.href !== null) navigate(open.href);
    },
    [workspaceId, workspaceKey, newTrace, navigate, markReadLocal, toast],
  );

  // Open a thread from its lead entry: only the lead is marked read, so the
  // rest stay unread and the card stays highlighted until they are seen.
  const handleOpenGroup = useCallback(
    (group: ActivityItem[]) => {
      const lead = group[0];
      if (lead !== undefined) handleOpenEntry(lead);
    },
    [handleOpenEntry],
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
  // write immediately; no Undo and no confirmation toast (the unread state just
  // clears). On failure the rows go back to unread with a fixed error toast.
  // The All chip is ONE call to inbox_mark_all_read (every unread, never-snoozed
  // row of every type); another chip marks its own rows one by one. Then the
  // Mentions count and the nav badge refetch. A failed scheduled send is never
  // an optimistic target (markAllTargets); Upcoming has no targets.
  const handleMarkAll = useCallback(() => {
    if (workspaceId === null) return;
    const targets = markAllTargets(items, state, nowMs);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((item) => item.id));
    const stamp = new Date().toISOString();
    const chip = state;
    setItems((prev) => prev.map((item) => (ids.has(item.id) ? { ...item, readAt: stamp } : item)));
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

  // A failed scheduled send's Retry: send it now (the proc clears the entry),
  // or clear an entry already resolved elsewhere; then reload the feed.
  const handleRetry = useCallback(
    (item: ActivityItem) => {
      if (workspaceId === null) return;
      const traceId = newTrace();
      void retryFailedSend(supabase, item, workspaceId, traceId).then((outcome) => {
        if (outcome.kind === 'failed') {
          logger.warn('notifications: retry failed', {
            trace_id: traceId,
            error: outcome.message,
          });
          if (outcome.copy !== null) toast?.show({ title: outcome.copy });
        }
        void loadActivity();
        window.dispatchEvent(new CustomEvent('sorted:inbox-changed'));
      });
    },
    [workspaceId, newTrace, toast, loadActivity],
  );

  // A failed scheduled send's Edit: open its chat (the composer lists the
  // chat's scheduled messages); an entry resolved elsewhere just clears.
  const handleEdit = useCallback(
    (item: ActivityItem) => {
      const alert = item.alert;
      if (alert == null) return;
      if (alert.stale) {
        handleMarkRead(item);
        return;
      }
      if (alert.channelId !== null) navigate(chatMessageHref(alert.channelId, null));
    },
    [handleMarkRead, navigate],
  );

  // Upcoming's Edit and Cancel, as the bell had them: a reminder's Change time
  // (the reminder sheet in change mode, with Cancel reminder) and Cancel (a
  // confirm); a scheduled message's Edit ("Scheduled in this chat": Send now,
  // Edit, Time, Don't send) and Cancel (a confirm). Every write carries its
  // own trace id; a failure toasts "Couldn't do that. Try again." (a "not
  // found" stays silent) and the rows reload.
  const upcomingFailed = useCallback(
    (what: string, traceId: string, message: string, copy: string | null = ACTION_FAILED_COPY) => {
      logger.warn(`notifications: ${what} failed`, { trace_id: traceId, error: message });
      if (copy !== null) toast?.show({ title: copy });
    },
    [toast],
  );
  const reminderActions = useMemo(
    () =>
      createReminderActions({
        client: supabase,
        newTraceId: newTrace,
        newId: newMessageId,
        failed: upcomingFailed,
        notify: (title) => toast?.show({ title }),
        // Every reminder reader reloads, Upcoming included (the listener above).
        remindersChanged: announceRemindersChanged,
        reminderChanged: () => undefined,
      }),
    [newTrace, upcomingFailed, toast],
  );
  const upcomingRef = useRef(upcoming);
  upcomingRef.current = upcoming;
  const scheduledWrites = useMemo(
    () =>
      createUpcomingScheduledWrites({
        client: supabase,
        newTraceId: newTrace,
        reload: () => void loadUpcoming(),
        failed: upcomingFailed,
        channelTypeOf: (channelId) =>
          upcomingRef.current.find((item) => item.channelId === channelId)?.channelType ?? null,
      }),
    [newTrace, loadUpcoming, upcomingFailed],
  );
  const [reminderEdit, setReminderEdit] = useState<UpcomingItem | null>(null);
  const [scheduledChat, setScheduledChat] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<UpcomingItem | null>(null);
  // The confirm keeps its words while it slides away (the target clears first).
  const cancelShownRef = useRef<UpcomingItem | null>(null);
  if (cancelTarget !== null) cancelShownRef.current = cancelTarget;
  const cancelShown = cancelShownRef.current;

  const visibleUpcoming = useMemo(
    () => upcoming.filter((item) => !hiddenUpcoming.has(item.id)),
    [upcoming, hiddenUpcoming],
  );
  const scheduledSheetRows = useMemo(
    () =>
      scheduledChat === null
        ? []
        : visibleUpcoming.flatMap((item) =>
            item.kind === 'scheduled' && item.channelId === scheduledChat ? [item.row] : [],
          ),
    [visibleUpcoming, scheduledChat],
  );

  const handleOpenUpcoming = useCallback(
    (item: UpcomingItem) => navigate(upcomingHref(item)),
    [navigate],
  );
  const handleEditUpcoming = useCallback((item: UpcomingItem) => {
    if (item.kind === 'reminder') setReminderEdit(item);
    else setScheduledChat(item.channelId);
  }, []);

  const cancelUpcoming = useCallback(
    async (item: UpcomingItem): Promise<boolean> => {
      setHiddenUpcoming((prev) => new Set([...prev, item.id]));
      const ok =
        item.kind === 'reminder'
          ? await reminderActions.cancelReminder(item.row)
          : await scheduledWrites.onCancel(item.row);
      if (!ok) {
        setHiddenUpcoming((prev) => new Set([...prev].filter((id) => id !== item.id)));
      }
      return ok;
    },
    [reminderActions, scheduledWrites],
  );

  const confirmCancel = useCallback(() => {
    const target = cancelTarget;
    setCancelTarget(null);
    if (target !== null) void cancelUpcoming(target);
  }, [cancelTarget, cancelUpcoming]);

  const pickReminderTime = useCallback(
    (at: Date) => {
      const target = reminderEdit;
      setReminderEdit(null);
      if (target?.kind !== 'reminder') return;
      void reminderActions.setReminderAt(
        { messageId: target.row.message_id, channelId: target.row.channel_id },
        at,
      );
    },
    [reminderEdit, reminderActions],
  );

  const cancelFromReminderSheet = useCallback(() => {
    const target = reminderEdit;
    setReminderEdit(null);
    if (target === null) return;
    void cancelUpcoming(target).then((ok) => {
      if (ok) toast?.show({ title: REMINDER_CANCELLED_COPY });
    });
  }, [reminderEdit, cancelUpcoming, toast]);

  const listLoading = workspaceId === null || (loading && items.length === 0);

  return (
    <>
      <PageHead
        title={NOTIFICATIONS_TITLE}
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

      {state === 'upcoming' ? (
        upcomingError ? (
          <LoadFailed onRetry={() => void loadUpcoming()} />
        ) : workspaceId === null || !upcomingLoaded ? (
          <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading activity</div>
        ) : visibleUpcoming.length === 0 ? (
          <EmptyState icon={<IconCalendarClock size={24} />} title={UPCOMING_EMPTY} />
        ) : (
          <div data-upcoming-list="" className="mt-4 flex flex-col gap-2 px-4 pb-6 md:px-6">
            {visibleUpcoming.map((item) => (
              <UpcomingCard
                key={item.id}
                item={item}
                now={new Date(nowMs)}
                onOpen={handleOpenUpcoming}
                onEdit={handleEditUpcoming}
                onCancel={setCancelTarget}
              />
            ))}
          </div>
        )
      ) : error ? (
        <LoadFailed onRetry={() => void loadActivity()} />
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
        ) : state === 'plans' ? (
          <EmptyState icon={<IconPlan size={24} />} title="You are all caught up" />
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
                        side={side}
                        onRetry={handleRetry}
                        onEdit={handleEdit}
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

      <ReminderSheet
        open={reminderEdit !== null}
        onClose={() => setReminderEdit(null)}
        preview={reminderEdit?.preview ?? null}
        onPick={pickReminderTime}
        change={{ onCancelReminder: cancelFromReminderSheet }}
      />
      <ScheduledListSheet
        open={scheduledChat !== null && scheduledSheetRows.length > 0}
        onClose={() => setScheduledChat(null)}
        rows={scheduledSheetRows}
        nameOf={mentionNamesIn(workspaceId)}
        {...scheduledWrites}
      />
      <Sheet
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title={cancelShown?.kind === 'scheduled' ? CANCEL_CONFIRM_TITLE : CANCEL_REMINDER_TITLE}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button type="button" size="lg" onClick={() => setCancelTarget(null)}>
              Keep
            </Button>
            <Button
              type="button"
              size="lg"
              variant="danger"
              data-confirm-cancel-upcoming=""
              onClick={confirmCancel}
            >
              {cancelShown?.kind === 'scheduled' ? DONT_SEND_LABEL : CANCEL_REMINDER_LABEL}
            </Button>
          </div>
        }
      >
        <p className="truncate text-sm text-fg-2">{cancelShown?.preview ?? ''}</p>
      </Sheet>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
