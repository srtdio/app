import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { useTopbarActions } from '@/components/shell/topbar-actions';
import { ICON_SIZE, IconActivity, IconAt, IconTickDouble } from '@/components/ui/icons';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { ActivityFilterBar, activityChip } from '@/components/pages/activity/ActivityFilterBar';
import { cn } from '@/lib/cn';
import { Text, textRole } from '@/components/ui/Text';
import { GUTTER } from '@/components/ui/layout';
import { mentionHandle } from '@/lib/chat/mentions';
import { errorText } from '@/lib/error-copy';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { logger } from '@/lib/logger';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { POLL_CHANGE_SOURCE } from '@/lib/inbox/inbox-live';
import { getFillCount } from '@/lib/use-fill-count';
import {
  ACTIVITY_SORT_DEFAULT,
  EMPTY_LINES,
  activityPageKey,
  editKeptActivityPages,
  invalidateActivityReads,
  mentionCountKey,
  peekActivityPage,
  peekMentionCount,
  sharedActivityPage,
  sharedMentionCount,
  type LoadResult,
  appendUnique,
  cursorAfter,
  fetchActivityEntries,
  filterByState,
  groupDigest,
  ACTIVITY_LOAD_FAILED,
  MARKED_READ_LABEL,
  markAllTargets,
  markAllEntriesRead,
  markChipRead,
  markEntryRead,
  marksChipOnServer,
  marksWholeInbox,
  mergeFresh,
  msUntilZonedMidnight,
  openAction,
  unreadCount,
  updatesLabel,
  type ActivityDirection,
  type ActivityItem,
} from '@/components/pages/activity/data';
import { readActivityBadge } from '@/lib/inbox/inbox-reads';
import { generateTraceId } from '@/lib/trace';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { keptViewKey, useKeptScroll, useKeptState, useUntouched } from '@/lib/kept-view';
import { onSessionReadsHydrated } from '@/lib/session-read';
import { useCurrentProfile } from '@/lib/use-current-profile';
import { useWorkspace } from '@/lib/workspace-context';
import { env } from '@/lib/env';
import { INDUCTION_KEYS } from '@/lib/induction';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { useOptionalToast } from '@/components/ui/toast';
import { undoFailureTitle } from '@/lib/use-undoable-action';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import { ActivityBoxes } from '@/components/pages/activity/ActivityBoxes';

/** Failure copy for Mark all read: "Couldn't mark as read. {reason}" */
const MARK_READ_FAILED = undoFailureTitle(MARKED_READ_LABEL);

/** The page title: the surface is Activity. */
export const ACTIVITY_TITLE = 'Activity';

/** Mark all read's label (the top bar's primary IconButton). */
export const MARK_ALL_READ_LABEL = 'Mark all read';

/**
 * How a feed load lands: 'reset' clears the list first (a chip or workspace
 * change); 'refresh' replaces it but keeps it on a failure; 'merge'
 * folds a fresh page one into it (new rows from the shell's poll).
 */
type LoadMode = 'reset' | 'refresh' | 'merge';

/** The topmost on-screen card and where it sat, to hold it still across a merge. */
interface ScrollAnchor {
  id: string;
  top: number;
}

/** The nearest scrolling ancestor of an element, or null for the window. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node !== null; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/** The first card at or below the top of the viewport, once the list is scrolled. */
function captureAnchor(list: HTMLElement | null): ScrollAnchor | null {
  if (list === null) return null;
  const scroller = scrollParentOf(list);
  const scrolled = scroller !== null ? scroller.scrollTop : window.scrollY;
  if (scrolled <= 0) return null;
  for (const card of list.querySelectorAll<HTMLElement>('[data-activity-id]')) {
    const top = card.getBoundingClientRect().top;
    if (top >= 0) return { id: card.dataset.activityId ?? '', top };
  }
  return null;
}

/** Scroll by however far the anchor card moved, so cards added above it never jump the view. */
function restoreAnchor(list: HTMLElement | null, anchor: ScrollAnchor): void {
  if (list === null) return;
  const card = list.querySelector<HTMLElement>(`[data-activity-id="${anchor.id}"]`);
  if (card === null) return;
  const delta = card.getBoundingClientRect().top - anchor.top;
  if (delta === 0) return;
  const scroller = scrollParentOf(list);
  if (scroller !== null) scroller.scrollTop += delta;
  else window.scrollBy(0, delta);
}

/** A load failure: the plain copy and Retry. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-4 md:px-6 mt-4">
      <ErrorNote>{ACTIVITY_LOAD_FAILED}</ErrorNote>
      <div className="mt-3">
        <Button onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  // Today and Yesterday follow the workspace's timezone, not the device's.
  const tz = workspaces.find((row) => row.id === workspaceId)?.timezone ?? null;
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

  // A return lands on the same chip and scroll (src/lib/kept-view.ts).
  const keptKey = (what: string): string | null =>
    userId !== null && workspaceId !== null
      ? keptViewKey(userId, workspaceId, `activity:${what}`)
      : null;
  const [keptChip, setState] = useKeptState<string>(keptKey('chip'), 'all');
  // A chip kept from before a chip was retired (Snoozed, Briefs, Plans) reads as All.
  const state = activityChip(keptChip);
  const untouched = useUntouched();

  // The order: Newest first, always (the top bar has no sort, decided 7 Nov).
  // Page one is read server-side in that order (keyset on created_at, id).
  const sort: ActivityDirection = ACTIVITY_SORT_DEFAULT;

  // The chip's page one as the bell press or an earlier visit this session
  // read it: the first frame is the list, refreshed quietly behind it. Else
  // the first frame is the loading line, never the zero state (loading starts
  // true: the load runs in an effect, after the first paint).
  const [items, setItems] = useState<ActivityItem[]>(() =>
    userId !== null && workspaceId !== null
      ? (peekActivityPage(activityPageKey(userId, workspaceId, state, sort)) ?? [])
      : [],
  );
  const [loading, setLoading] = useState(
    () =>
      userId === null ||
      workspaceId === null ||
      peekActivityPage(activityPageKey(userId, workspaceId, state, sort)) === undefined,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  // The list's one clock: the shared minute clock (useMinuteClock, one interval
  // app-wide, no timer per card) ages every card's "5m"; a load stamps
  // the instant it landed so a fresh page never reads an older minute.
  const clockMs = useMinuteClock();
  const [loadedMs, setNowMs] = useState(() => Date.now());
  const nowMs = Math.max(clockMs, loadedMs);
  const [mentionCount, setMentionCount] = useState(
    () =>
      (userId !== null && workspaceId !== null
        ? peekMentionCount(mentionCountKey(userId, workspaceId))
        : undefined) ?? 0,
  );
  const toast = useOptionalToast();
  // A failure line rides the shared toast in its error tone.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const push = useCallback((message: string): void => {
    toastRef.current?.show({ title: message, tone: 'error' });
  }, []);

  // One presign cache for the whole feed: it bounds concurrency and caches URLs
  // so every card thumbnail shares a single cap, mirroring PipelinePage. Cards
  // lazy-resolve their own thumbnail via useInView; the page adds no fetches.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();

  // The latest values, read by async loads to drop a result that went stale.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  // The page key whose device-saved page one painted late (the saved screens
  // seeded after this mount): the read already running for it lands quietly.
  const lateKeptRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  // Bumped by every reset or refresh: an older load, merge or load-more is dropped.
  const activitySeqRef = useRef(0);
  const loadingMoreRef = useRef(false);
  // Cards a live merge just added (they slide up), and the card to hold still.
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ScrollAnchor | null>(null);

  // Load page one for the active chip. Every chip filters server-side (All has
  // no filter) and the server orders newest first, so older matches are never
  // hidden behind the page cap. A stale response (the chip or workspace moved
  // on) is dropped. A failure with rows on screen keeps them and
  // toasts; only a first load with nothing on screen shows the error box.
  // Page one is the chip's shared session read (activity/data.ts): a chip
  // switch (or the mount) paints the kept page at once and refreshes quietly
  // behind it (no request while it is fresh); the refresh behind the arrival
  // paint (`arrival`) is applied only while the person has not touched the
  // screen, else held for the next visit. A refresh (a retry, a failed write,
  // workspace data) reads anew; a merge follows an inbox change, which already
  // marked the kept pages stale.
  const loadActivity = useCallback(
    async (mode: LoadMode = 'refresh', arrival = false) => {
      if (workspaceId === null) return;
      if (mode !== 'merge') activitySeqRef.current += 1;
      const seq = activitySeqRef.current;
      const key = userId !== null ? activityPageKey(userId, workspaceId, state, sort) : null;
      if (mode !== 'merge') lateKeptRef.current = null;
      if (mode === 'refresh' && key !== null) invalidateActivityReads(key);
      // The kept page painted by this reset; its refresh is quiet.
      const held = mode === 'reset' && key !== null ? peekActivityPage(key) : undefined;
      if (mode === 'reset') {
        setItems(held ?? []);
        // A kept page from an earlier load can be longer than this load's count.
        setHasMore(held !== undefined && held.length >= getFillCount());
        setEntering(new Set());
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
      if (held !== undefined) {
        setNowMs(Date.now());
        setLoading(false);
        setError(false);
      } else if (mode !== 'merge') {
        setLoading(true);
        setError(false);
      }
      const read = (): Promise<LoadResult> =>
        fetchActivityEntries(supabase, workspaceId, {
          state,
          direction: sort,
          // Page one fills the screen (getFillCount: sync, read once per app load).
          pageSize: getFillCount(),
        });
      mark('activity:page1:start');
      const result = key !== null ? await sharedActivityPage(key, read) : await read();
      mark('activity:page1:end');
      if (seq !== activitySeqRef.current) return;
      setNowMs(Date.now());
      if (mode !== 'merge') setLoading(false);
      // A kept page is on screen: painted by this reset, or seeded late from the device.
      const quiet = held !== undefined || (key !== null && lateKeptRef.current === key);
      if (!result.ok) {
        logger.warn('notifications: load failed', { error: result.error });
        // A failed quiet refresh keeps the kept page, silently.
        if (mode === 'merge' || quiet) return;
        if (itemsRef.current.length > 0) push(errorText('refresh', result.error));
        else setError(true);
        return;
      }
      // A quiet refresh behind the arrival paint never moves what the person touched.
      if (quiet && arrival && !untouched()) return;
      if (mode === 'merge') {
        const known = new Set(itemsRef.current.map((item) => item.id));
        const added = result.data.filter((item) => !known.has(item.id));
        setEntering(new Set(added.map((item) => item.id)));
        anchorRef.current = captureAnchor(listRef.current);
        setItems((prev) => mergeFresh(prev, result.data, sort));
        return;
      }
      setItems(result.data);
      setHasMore(result.data.length >= getFillCount());
    },
    [workspaceId, userId, state, sort, push, untouched],
  );

  // Hold the topmost visible card still when a merge adds cards above it.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor !== null) restoreAnchor(listRef.current, anchor);
  }, [items]);

  // Fetch the next page in the sort order after the last loaded (created_at,
  // id) and append it without duplicates. It carries the chip and sort it
  // started with and is ignored if they (or the list) changed since.
  const loadMore = useCallback(async () => {
    if (workspaceId === null || loadingMoreRef.current) return;
    const cursor = cursorAfter(itemsRef.current);
    if (cursor === undefined) return;
    const seq = activitySeqRef.current;
    const chip = state;
    const direction = sort;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const result = await fetchActivityEntries(supabase, workspaceId, {
      state: chip,
      direction,
      cursor,
      // Load more adds the same count again.
      pageSize: getFillCount(),
    });
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (
      seq !== activitySeqRef.current ||
      stateRef.current !== chip ||
      sortRef.current !== direction
    ) {
      return;
    }
    if (!result.ok) {
      push(errorText('load more activity', result.error));
      return;
    }
    setItems((prev) => appendUnique(prev, result.data));
    setHasMore(result.data.length >= getFillCount());
  }, [workspaceId, state, sort, push]);

  // The unread-mention count for the Mentions chip. Independent of the active
  // view, so it is not affected by the chips. It rides the shared activity
  // badge read (one activity_badge_read gives the shell's badge and this count).
  // The mount and the shell poll's event (`join`) join the bell press's or the
  // tick's read while fresh; every other load (a write) refreshes, and the
  // change event that write dispatches joins that same read.
  const loadMentionCount = useCallback(
    async (join = false) => {
      if (workspaceId === null || userId === null) return;
      const key = mentionCountKey(userId, workspaceId);
      if (!join) invalidateActivityReads(key);
      const res = await sharedMentionCount(key, async () => {
        const badge = await readActivityBadge(supabase, {
          userId,
          workspaceId,
          traceId: generateTraceId(),
          refresh: !join,
        });
        return badge.ok ? { ok: true as const, data: badge.data.mentions } : badge;
      });
      if (res.ok) setMentionCount(res.data);
    },
    [workspaceId, userId],
  );

  // The first load of this mount is the arrival (the identity of the first
  // loadActivity: a chip, sort or workspace change makes a new one).
  const arrivalLoadRef = useRef<typeof loadActivity | null>(null);
  useEffect(() => {
    mark('activity:mount');
    arrivalLoadRef.current ??= loadActivity;
    const arrival = arrivalLoadRef.current === loadActivity;
    void loadActivity('reset', arrival);
  }, [loadActivity]);

  // A cold open can mount this page before the device's saved screens are
  // seeded (hydrateSessionReads runs beside the boot; nothing waits on it).
  // When they land, a list still on its loading line paints the saved page one
  // at once, and the read already running lands over it as a quiet refresh.
  // The Mentions count takes its saved value the same way.
  // Adds no read and no wait: it only paints sooner than the read would.
  useEffect(() => {
    if (userId === null || workspaceId === null) return undefined;
    return onSessionReadsHydrated(() => {
      const count = peekMentionCount(mentionCountKey(userId, workspaceId));
      if (count !== undefined) setMentionCount(count);
      if (!loadingRef.current || itemsRef.current.length > 0) return;
      const key = activityPageKey(userId, workspaceId, stateRef.current, sortRef.current);
      const kept = peekActivityPage(key);
      if (kept === undefined) return;
      lateKeptRef.current = key;
      setItems(kept);
      setHasMore(kept.length >= getFillCount());
      setNowMs(Date.now());
      setLoading(false);
      setError(false);
      mark('activity:kept-paint');
    });
  }, [userId, workspaceId]);

  // New rows found by the shell's poll: fold page one in (no duplicates, no
  // scroll jump) and refresh the Mentions count. A local write's event is not
  // the poll's, so the page never reloads for its own mark-read.
  useEffect(() => {
    const onChanged = (event: Event): void => {
      if (!(event instanceof CustomEvent) || event.detail !== POLL_CHANGE_SOURCE) return;
      void loadActivity('merge');
      // The tick already read the badge: join it.
      void loadMentionCount(true);
    };
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
  }, [loadActivity, loadMentionCount]);

  // Relative times keep moving on the shared minute clock (clockMs above); the
  // return to a hidden tab re-stamps at once so nothing reads a stale minute.
  useEffect(() => {
    const onVisibility = (): void => {
      if (!document.hidden) setNowMs(Date.now());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Today and Yesterday roll over at midnight in the workspace timezone.
  useEffect(() => {
    const timer = window.setTimeout(() => setNowMs(Date.now()), msUntilZonedMidnight(nowMs, tz));
    return () => window.clearTimeout(timer);
  }, [nowMs, tz]);

  useEffect(() => {
    void loadMentionCount(true);
  }, [loadMentionCount]);
  useWorkspaceDataChanged(() => {
    void loadActivity();
    void loadMentionCount();
  });

  const buckets = useMemo(
    () => groupDigest(filterByState(items, state, nowMs), sort, { nowMs, tz }),
    [items, state, sort, nowMs, tz],
  );

  const totalUnread = useMemo(() => unreadCount(items, nowMs), [items, nowMs]);

  // An own write lands at once, on screen and in every kept chip page, so a
  // return paints it.
  const editItems = useCallback(
    (edit: (items: ActivityItem[]) => ActivityItem[]) => {
      setItems(edit);
      if (userId !== null && workspaceId !== null) {
        editKeptActivityPages(userId, workspaceId, edit);
      }
    },
    [userId, workspaceId],
  );

  // Put rows a failed save had marked back to unread (only those still carrying its stamp).
  const revertRead = useCallback(
    (ids: ReadonlySet<string>, stamp: string) => {
      editItems((prev) =>
        prev.map((item) =>
          ids.has(item.id) && item.readAt === stamp ? { ...item, readAt: null } : item,
        ),
      );
    },
    [editItems],
  );

  // Mark entries read at once (optimistic, one trace) and save them together.
  // Only the rows whose save failed go back to unread, with the fixed toast; any
  // success refreshes the Mentions count and the nav badge.
  const markEntriesRead = useCallback(
    (entries: readonly ActivityItem[]) => {
      if (workspaceId === null || entries.length === 0) return;
      const ids = new Set(entries.map((entry) => entry.id));
      const stamp = new Date().toISOString();
      editItems((prev) =>
        prev.map((item) =>
          ids.has(item.id) && item.readAt === null ? { ...item, readAt: stamp } : item,
        ),
      );
      const traceId = newTrace();
      void Promise.all(
        entries.map((entry) => markEntryRead(supabase, entry, workspaceId, traceId)),
      ).then((results) => {
        const failed = new Set(
          entries.flatMap((entry, i) => (results[i]?.ok === true ? [] : [entry.id])),
        );
        if (failed.size > 0) {
          logger.warn('notifications: mark read failed', {
            trace_id: traceId,
            count: failed.size,
          });
          revertRead(failed, stamp);
          toast?.show({ title: MARK_READ_FAILED });
        }
        if (failed.size < entries.length) {
          void loadMentionCount();
          window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
        }
      });
    },
    [workspaceId, newTrace, editItems, revertRead, toast, loadMentionCount],
  );

  // Open one entry by its tap rule (openAction): mark it read (optimistic, and
  // reverted with a toast if the save fails), toast a
  // deleted plan, then navigate to its link.
  const handleOpenEntry = useCallback(
    (entry: ActivityItem) => {
      if (workspaceId === null) return;
      const open = openAction(entry, workspaceKey, side);
      if (open.markRead && entry.readAt === null) markEntriesRead([entry]);
      if (open.toast !== null) toast?.show({ title: open.toast });
      if (open.href !== null) navigate(open.href);
    },
    [workspaceId, workspaceKey, side, navigate, markEntriesRead, toast],
  );

  // Open a thread: every unread entry in the group is marked read in one batch
  // then it opens from `entry` (the card's groupOpenEntry:
  // the newest entry that links to a comment, else the lead).
  const handleOpenGroup = useCallback(
    (group: ActivityItem[], entry: ActivityItem) => {
      if (workspaceId === null) return;
      const open = openAction(entry, workspaceKey, side);
      const unread = group.filter(
        (e) => e.readAt === null && openAction(e, workspaceKey, side).markRead,
      );
      markEntriesRead(unread);
      if (open.toast !== null) toast?.show({ title: open.toast });
      if (open.href !== null) navigate(open.href);
    },
    [workspaceId, workspaceKey, side, navigate, markEntriesRead, toast],
  );

  // The active chip only: mark its unread rows (no snooze, or one that has run
  // out) read at once and write immediately; no Undo and no confirmation toast.
  // All and Unread are ONE call to inbox_mark_all_read (every unread row of
  // every type, run-out snoozes included). Mentions marks every matching row
  // on the server, loaded or not, 500 ids per inbox_mark_read_ids call
  // (markChipRead); a failure part way reloads the list, so only the rows that
  // did not save show unread again. Then the Mentions count and the nav badge
  // refetch.
  const handleMarkAll = useCallback(() => {
    if (workspaceId === null) return;
    const targets = markAllTargets(items, state, nowMs);
    if (targets.length === 0) return;
    if (marksChipOnServer(state)) {
      const ids = new Set(targets.map((item) => item.id));
      const stamp = new Date().toISOString();
      editItems((prev) =>
        prev.map((item) => (ids.has(item.id) ? { ...item, readAt: stamp } : item)),
      );
      const traceId = newTrace();
      void markChipRead(supabase, { workspaceId, state, traceId }).then((result) => {
        if (!result.ok) {
          logger.warn('notifications: chip mark read failed', {
            trace_id: traceId,
            error: result.error.message,
          });
          toast?.show({ title: MARK_READ_FAILED });
          void loadActivity();
        }
        void loadMentionCount();
        window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      });
      return;
    }
    if (!marksWholeInbox(state)) {
      markEntriesRead(targets);
      return;
    }
    const ids = new Set(targets.map((item) => item.id));
    const stamp = new Date().toISOString();
    editItems((prev) => prev.map((item) => (ids.has(item.id) ? { ...item, readAt: stamp } : item)));
    const traceId = newTrace();
    void markAllEntriesRead(supabase, workspaceId, traceId).then((result) => {
      if (!result.ok) {
        logger.warn('notifications: mark all read failed', {
          trace_id: traceId,
          error: result.error.message,
        });
        revertRead(ids, stamp);
        toast?.show({ title: MARK_READ_FAILED });
        return;
      }
      void loadMentionCount();
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    });
  }, [
    workspaceId,
    items,
    state,
    nowMs,
    newTrace,
    toast,
    loadMentionCount,
    loadActivity,
    markEntriesRead,
    editItems,
    revertRead,
  ]);

  // The top bar: Mark all read as the primary (IconTickDouble), for the
  // active chip; at 0 unread the slot is empty (it keeps its width). No sort
  // (decided 7 Nov). The latest handler rides a ref so the published node
  // changes only when the unread state does.
  const chipUnread = useMemo(
    () => markAllTargets(items, state, nowMs).length,
    [items, state, nowMs],
  );
  const markAllRef = useRef(handleMarkAll);
  markAllRef.current = handleMarkAll;
  const hasUnread = chipUnread > 0;
  const markAllNode = useMemo(
    () =>
      hasUnread ? (
        <IconButton
          label={MARK_ALL_READ_LABEL}
          data-activity-mark-all=""
          onClick={() => markAllRef.current()}
        >
          <IconTickDouble size={ICON_SIZE.control} />
        </IconButton>
      ) : undefined,
    [hasUnread],
  );
  useTopbarActions({ primary: markAllNode });

  const listLoading = workspaceId === null || (loading && items.length === 0);
  if (!listLoading) mark('activity:paint');
  // What the first frame painted (?paintlog): the kept or device-saved page,
  // or the loading line (nothing saved for this chip yet).
  const firstPaintRef = useRef<string | null>(null);
  firstPaintRef.current ??= listLoading ? 'activity:loading-paint' : 'activity:kept-paint';
  useLayoutEffect(() => {
    if (firstPaintRef.current !== null) mark(firstPaintRef.current);
  }, []);
  useKeptScroll(keptKey('scroll'), !listLoading);
  // Boxes only while nothing is held for the list; the cards settle once when
  // they land after them (a kept or device-saved page paints at once).
  const hadBoxes = useHadBoxes(listLoading && !(error && items.length === 0));
  useSettleOnLanding(listRef, !listLoading, hadBoxes);

  return (
    <>
      {/* No visible title (as Pipeline, Briefs, Assets and Plan): the page starts with the
          chip row (Mark all read lives in the top bar). The h1 stays for
          screen readers and e2e. */}
      <h1 tabIndex={-1} className="sr-only">
        {ACTIVITY_TITLE}
      </h1>

      <ActivityFilterBar
        state={state}
        onStateChange={setState}
        totalUnread={totalUnread}
        mentionCount={mentionCount}
      />

      {error && items.length === 0 ? (
        <LoadFailed onRetry={() => void loadActivity()} />
      ) : listLoading ? (
        <ActivityBoxes />
      ) : buckets.length === 0 ? (
        state === 'mentions' ? (
          <EmptyState icon={<IconAt size={ICON_SIZE.status} />} title={EMPTY_LINES.mentions} />
        ) : state === 'unread' ? (
          <EmptyState icon={<IconActivity size={ICON_SIZE.status} />} title={EMPTY_LINES.unread} />
        ) : (
          <EmptyState
            icon={<IconActivity size={ICON_SIZE.status} />}
            title="Activity across posts, briefs and people shows up here."
          />
        )
      ) : (
        <div ref={listRef} className="pb-6">
          {buckets.map((bucket, bucketIndex) => {
            const entries = bucket.groups.flat();
            return (
              <section key={bucket.key} className="mt-2">
                {/* One 44 line on the page edge: "YESTERDAY · 1 update" (Mark all read
                    lives in the top bar). */}
                <div
                  data-activity-bucket-head=""
                  className={cn('flex h-11 min-w-0 items-center gap-2', GUTTER)}
                >
                  <Text as="h2" role="section" className="shrink-0">
                    {bucket.label}
                  </Text>
                  <span aria-hidden="true" className={textRole('meta', 'shrink-0')}>
                    ·
                  </span>
                  <span data-bucket-count="" className={textRole('meta', 'min-w-0 truncate')}>
                    {updatesLabel(entries.length)}
                  </span>
                </div>
                <div data-activity-list="" className={cn(LIST_CARD_GRID, GUTTER)}>
                  {bucket.groups.map((group, groupIndex) => {
                    const card = (
                      <ActivityCard
                        key={group[0]?.id ?? bucket.key}
                        group={group}
                        nowMs={nowMs}
                        timeZone={tz}
                        cache={cache}
                        presignEnabled={presignEnabled}
                        onOpenGroup={handleOpenGroup}
                        onOpenEntry={handleOpenEntry}
                        selfName={selfName}
                        side={side}
                        entering={entering.has(group[0]?.id ?? '')}
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
              <Button variant="ghost" onClick={() => void loadMore()} busy={loadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
