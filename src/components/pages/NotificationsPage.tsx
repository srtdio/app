import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { Sheet } from '@/components/ui/Sheet';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import {
  ICON_SIZE,
  IconActivity,
  IconAlarmClock,
  IconAt,
  IconBriefs,
  IconCalendarClock,
  IconPlan,
} from '@/components/ui/icons';
import { ActivityCard, UpcomingCard } from '@/components/pages/activity/ActivityCard';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { ActivityFilterBar } from '@/components/pages/activity/ActivityFilterBar';
import { cn } from '@/lib/cn';
import { Text, textRole } from '@/components/ui/Text';
import { GUTTER } from '@/components/ui/layout';
import { REMINDER_CANCELLED_COPY, createReminderActions } from '@/components/chat/ReminderContext';
import { CANCEL_REMINDER_LABEL, ReminderSheet } from '@/components/chat/ReminderSheet';
import {
  CANCEL_CONFIRM_TITLE,
  DONT_SEND_LABEL,
  ScheduledListSheet,
} from '@/components/chat/ScheduledListSheet';
import { mentionHandle, mentionNamesIn } from '@/lib/chat/mentions';
import { newMessageId } from '@/lib/chat/message-id';
import { REMINDERS_CHANGED_EVENT, announceRemindersChanged } from '@/lib/chat/reminders';
import { errorText } from '@/lib/error-copy';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { logger } from '@/lib/logger';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { POLL_CHANGE_SOURCE } from '@/lib/inbox/inbox-live';
import {
  ACTIVITY_PAGE_SIZE,
  EMPTY_LINES,
  activityPageKey,
  editKeptActivityPages,
  invalidateActivityReads,
  keepUpcoming,
  mentionCountKey,
  peekActivityPage,
  peekMentionCount,
  peekUpcoming,
  sharedActivityPage,
  sharedMentionCount,
  upcomingKey,
  type LoadResult,
  appendUnique,
  cursorAfter,
  createUpcomingScheduledWrites,
  fetchActivityEntries,
  searchActivityEntries,
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
  markChipRead,
  markEntryRead,
  marksChipOnServer,
  marksWholeInbox,
  mergeFresh,
  msUntilZonedMidnight,
  openAction,
  retryFailedSend,
  snoozeEntry,
  unreadCount,
  updatesLabel,
  type ActivityDirection,
  type ActivityItem,
  type ActivityState,
  type SnoozeKind,
  type UpcomingItem,
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
import { useSort } from '@/lib/use-sort';
import { useServerSearch } from '@/lib/search/server-search';
import { env } from '@/lib/env';
import { INDUCTION_KEYS } from '@/lib/induction';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { useOptionalToast } from '@/components/ui/toast';
import { undoFailureTitle } from '@/lib/use-undoable-action';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import { ActivityBoxes, UpcomingBoxes } from '@/components/pages/activity/ActivityBoxes';

/** Failure copy for Mark all read: "Couldn't mark as read. {reason}" */
const MARK_READ_FAILED = undoFailureTitle(MARKED_READ_LABEL);

/** The page title: the surface is Activity. */
export const ACTIVITY_TITLE = 'Activity';

export const SORT_OPTIONS: SortOption<ActivityDirection>[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

/**
 * The sort while a search is on: activity_search pages newest first only, so
 * Oldest first is taken off the menu (never faked by reversing loaded pages)
 * and the results read newest first. Pure.
 */
export function activitySortOptions(searching: boolean): SortOption<ActivityDirection>[] {
  return searching ? SORT_OPTIONS.filter((option) => option.value === 'newest') : SORT_OPTIONS;
}

/** The list search's URL param (?q=), as on every list screen. */
const SEARCH_PARAM = 'q';

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

/**
 * How a feed load lands: 'reset' clears the list first (a chip, sort or
 * workspace change); 'refresh' replaces it but keeps it on a failure; 'merge'
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

/** A load failure: the plain copy and Retry (the feed's and Upcoming's). */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-4 md:px-6 mt-4">
      <div
        role="alert"
        className="lit-card rounded-xl border border-bad bg-panel px-4 py-3 text-base text-bad"
      >
        {ACTIVITY_LOAD_FAILED}
      </div>
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
  const [state, setState] = useKeptState<ActivityState>(keptKey('chip'), 'all');
  const { value: storedSort, setValue: setSort } = useSort<ActivityDirection>('activity', 'newest');
  const untouched = useUntouched();

  // The search box lives in the URL (?q=), so Back lands on the same results.
  // From 2 characters (src/lib/search/server-search.ts), 250ms after the last
  // keystroke, page one of activity_search replaces the feed (a newer query
  // aborts the one in flight): every chip's rows, newest first, through the
  // same mapping and batched joins as the feed. The chips hide while it is on.
  const [params, setParams] = useSearchParams();
  const search = params.get(SEARCH_PARAM) ?? '';
  const setSearch = useCallback(
    (value: string): void => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === '') next.delete(SEARCH_PARAM);
          else next.set(SEARCH_PARAM, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const activitySearch = useServerSearch<ActivityItem[]>(
    search,
    (query, signal) =>
      workspaceId === null
        ? Promise.resolve({ ok: true as const, data: [] })
        : searchActivityEntries(supabase, workspaceId, { query }, signal),
    workspaceId ?? '',
  );
  const searching = activitySearch.active;
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  // The query the search results on screen answer ('' while not searching).
  const searchQueryRef = useRef(activitySearch.query);
  searchQueryRef.current = searching ? activitySearch.query : '';
  // Whether a search ran on this mount: the feed's reload after it is no
  // longer the arrival's quiet refresh.
  const searchedRef = useRef(false);
  if (searching) searchedRef.current = true;
  // Oldest first is not offered while searching: the results read newest first.
  const sort: ActivityDirection = searching ? 'newest' : storedSort;

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
  // app-wide, no timer per card) ages every card's "5 min ago"; a load stamps
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

  // Load page one for the active chip and sort. Every chip filters server-side
  // (All has no filter) and the server orders by the sort, so older matches are
  // never hidden behind the page cap. A stale response (the chip, sort or
  // workspace moved on) is dropped. A failure with rows on screen keeps them and
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
        setHasMore(held !== undefined && held.length === ACTIVITY_PAGE_SIZE);
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
        });
      mark('activity:page1:start');
      const result = key !== null ? await sharedActivityPage(key, read) : await read();
      mark('activity:page1:end');
      if (seq !== activitySeqRef.current) return;
      // A feed load that lands while a search is on screen is dropped.
      if (searchingRef.current) return;
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
      setHasMore(result.data.length === ACTIVITY_PAGE_SIZE);
    },
    [workspaceId, userId, state, sort, push, untouched],
  );

  // Hold the topmost visible card still when a merge adds cards above it.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor !== null) restoreAnchor(listRef.current, anchor);
  }, [items]);

  // Fetch the next page in the sort's direction after the last loaded
  // (created_at, id) and append it without duplicates. It carries the chip and
  // sort it started with and is ignored if either (or the list) changed since.
  const loadMore = useCallback(async () => {
    if (workspaceId === null || loadingMoreRef.current) return;
    const cursor = cursorAfter(itemsRef.current);
    if (cursor === undefined) return;
    const seq = activitySeqRef.current;
    const chip = state;
    const direction = sort;
    // While searching: the search's next page (keyset on created_at, id).
    const query = searching ? activitySearch.query : null;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const result =
      query !== null
        ? await searchActivityEntries(supabase, workspaceId, { query, cursor })
        : await fetchActivityEntries(supabase, workspaceId, {
            state: chip,
            direction,
            cursor,
          });
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (
      seq !== activitySeqRef.current ||
      stateRef.current !== chip ||
      sortRef.current !== direction ||
      (query ?? '') !== searchQueryRef.current
    ) {
      return;
    }
    if (!result.ok) {
      push(errorText('load more activity', result.error));
      return;
    }
    setItems((prev) => appendUnique(prev, result.data));
    setHasMore(result.data.length === ACTIVITY_PAGE_SIZE);
  }, [workspaceId, state, sort, push, searching, activitySearch.query]);

  // The search's page one replaces the feed on screen (the same items state,
  // so mark read, snooze and the rest work on the results as on the feed). A
  // feed load that lands meanwhile is dropped (loadActivity checks
  // searchingRef), and a Load more for another query (searchQueryRef).
  // Leaving the search reloads the feed (the arrival effect below).
  useEffect(() => {
    if (!searching) return;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setEntering(new Set());
    if (activitySearch.data !== null) {
      setItems(activitySearch.data);
      setHasMore(activitySearch.data.length === ACTIVITY_PAGE_SIZE);
      setNowMs(Date.now());
      setLoading(false);
      setError(false);
    } else if (activitySearch.status === 'error') {
      setItems([]);
      setHasMore(false);
      setLoading(false);
      setError(true);
    } else {
      setItems([]);
      setHasMore(false);
      setLoading(true);
      setError(false);
    }
  }, [searching, activitySearch.data, activitySearch.status]);

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

  // Upcoming: the viewer's scheduled messages not yet sent and pending
  // reminders, soonest first (fetchUpcoming). Never inbox rows: they never
  // count toward the unread badge and Mark all read never touches them. A
  // reload that fails keeps the rows on screen; only a first load shows the error.
  // The rows an earlier visit this session read paint at once; the arrival's
  // reload follows the feed's quiet rule.
  const keptUpcoming = (): UpcomingItem[] | undefined =>
    userId !== null && workspaceId !== null
      ? peekUpcoming(upcomingKey(userId, workspaceId))
      : undefined;
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>(() => keptUpcoming() ?? []);
  const [upcomingLoaded, setUpcomingLoaded] = useState(() => keptUpcoming() !== undefined);
  const [upcomingError, setUpcomingError] = useState(false);
  // Rows a cancel is removing, hidden at once until the reload drops them.
  const [hiddenUpcoming, setHiddenUpcoming] = useState<ReadonlySet<string>>(new Set());
  const upcomingSeqRef = useRef(0);
  const upcomingLoadedRef = useRef(upcomingLoaded);
  const loadUpcoming = useCallback(
    async (arrival = false) => {
      if (workspaceId === null) return;
      upcomingSeqRef.current += 1;
      const seq = upcomingSeqRef.current;
      mark('upcoming:start');
      const result = await fetchUpcoming(supabase, workspaceId);
      mark('upcoming:end');
      if (seq !== upcomingSeqRef.current) return;
      setNowMs(Date.now());
      if (!result.ok) {
        logger.warn('notifications: upcoming load failed', { error: result.error });
        if (!upcomingLoadedRef.current) setUpcomingError(true);
        return;
      }
      if (userId !== null) keepUpcoming(upcomingKey(userId, workspaceId), result.data);
      if (arrival && upcomingLoadedRef.current && !untouched()) return;
      upcomingLoadedRef.current = true;
      setUpcomingLoaded(true);
      setUpcomingError(false);
      setUpcoming(result.data);
      const present = new Set(result.data.map((item) => item.id));
      setHiddenUpcoming((prev) => new Set([...prev].filter((id) => present.has(id))));
    },
    [workspaceId, userId, untouched],
  );

  // Reset Upcoming when the active workspace changes, before that workspace's
  // first load below starts (the chip follows its own kept key). The feed's
  // own 'reset' load (loadActivity changes with the workspace) clears the old
  // workspace's rows first and drops its in-flight loads; bumping the feed's
  // sequence here too would drop that new load.
  const shownWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (shownWorkspaceRef.current === workspaceId) return;
    shownWorkspaceRef.current = workspaceId;
    upcomingSeqRef.current += 1;
    upcomingLoadedRef.current = false;
    setUpcoming([]);
    setUpcomingLoaded(false);
    setUpcomingError(false);
    setHiddenUpcoming(new Set());
  }, [workspaceId]);

  // The first load of this mount is the arrival (the identity of the first
  // loadActivity: a chip, sort or workspace change makes a new one).
  const arrivalLoadRef = useRef<typeof loadActivity | null>(null);
  useEffect(() => {
    mark('activity:mount');
    // A search shows its own results; the feed loads when it ends.
    if (searching) return;
    arrivalLoadRef.current ??= loadActivity;
    const arrival = arrivalLoadRef.current === loadActivity && !searchedRef.current;
    if (state === 'upcoming') void loadUpcoming(arrival);
    else void loadActivity('reset', arrival);
  }, [state, loadActivity, loadUpcoming, searching]);

  // A cold open can mount this page before the device's saved screens are
  // seeded (hydrateSessionReads runs beside the boot; nothing waits on it).
  // When they land, a list still on its loading line paints the saved page one
  // at once, and the read already running lands over it as a quiet refresh.
  // Upcoming and the Mentions count take their saved values the same way.
  // Adds no read and no wait: it only paints sooner than the read would.
  useEffect(() => {
    if (userId === null || workspaceId === null) return undefined;
    return onSessionReadsHydrated(() => {
      const count = peekMentionCount(mentionCountKey(userId, workspaceId));
      if (count !== undefined) setMentionCount(count);
      if (stateRef.current === 'upcoming') {
        if (upcomingLoadedRef.current) return;
        const rows = peekUpcoming(upcomingKey(userId, workspaceId));
        if (rows === undefined) return;
        upcomingLoadedRef.current = true;
        setUpcoming(rows);
        setUpcomingLoaded(true);
        setUpcomingError(false);
        mark('activity:kept-paint');
        return;
      }
      if (searchingRef.current) return;
      if (!loadingRef.current || itemsRef.current.length > 0) return;
      const key = activityPageKey(userId, workspaceId, stateRef.current, sortRef.current);
      const kept = peekActivityPage(key);
      if (kept === undefined) return;
      lateKeptRef.current = key;
      setItems(kept);
      setHasMore(kept.length === ACTIVITY_PAGE_SIZE);
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
    if (state === 'upcoming') return;
    const onChanged = (event: Event): void => {
      if (!(event instanceof CustomEvent) || event.detail !== POLL_CHANGE_SOURCE) return;
      // A search's results are never merged into; the feed folds them in on return.
      if (!searchingRef.current) void loadActivity('merge');
      // The tick already read the badge: join it.
      void loadMentionCount(true);
    };
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
  }, [state, loadActivity, loadMentionCount]);

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

  // A reminder set, cancelled or rung anywhere (and the shell's poll tick)
  // reloads Upcoming while it is on screen.
  useEffect(() => {
    if (state !== 'upcoming') return;
    const reload = (): void => void loadUpcoming();
    window.addEventListener(REMINDERS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(REMINDERS_CHANGED_EVENT, reload);
  }, [state, loadUpcoming]);

  useEffect(() => {
    void loadMentionCount(true);
  }, [loadMentionCount]);
  useWorkspaceDataChanged(() => {
    if (searchingRef.current) activitySearch.refresh();
    else if (state === 'upcoming') void loadUpcoming();
    else void loadActivity();
    void loadMentionCount();
  });

  // While searching the results cover every chip (no chip filter, snoozed rows
  // included), newest first.
  const buckets = useMemo(
    () =>
      searching
        ? groupDigest(items, sort, { nowMs, tz })
        : groupDigest(filterByState(items, state, nowMs), sort, { nowMs, tz }),
    [items, state, sort, nowMs, tz, searching],
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

  // Mark one entry read in place, optimistically (read-state is best-effort).
  const markReadLocal = useCallback(
    (id: string) => {
      const stamp = new Date().toISOString();
      editItems((prev) =>
        prev.map((item) =>
          item.id === id && item.readAt === null ? { ...item, readAt: stamp } : item,
        ),
      );
    },
    [editItems],
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
  // reverted with a toast if the save fails) unless it is a reminder, toast a
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
  // (a reminder stays), then it opens from `entry` (the card's groupOpenEntry:
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

  const handleMarkRead = useCallback(
    (item: ActivityItem) => {
      if (workspaceId === null || item.readAt !== null) return;
      markReadLocal(item.id);
      void markEntryRead(supabase, item, workspaceId, newTrace()).then((result) => {
        if (!result.ok) {
          push(errorText('mark as read', result.error));
          void loadActivity();
          return;
        }
        void loadMentionCount();
        window.dispatchEvent(new CustomEvent('sorted:inbox-changed'));
      });
    },
    [workspaceId, newTrace, markReadLocal, push, loadActivity, loadMentionCount],
  );

  // The active chip only: mark its unread rows (no snooze, or one that has run
  // out) read at once and write immediately; no Undo and no confirmation toast.
  // All and Unread are ONE call to inbox_mark_all_read (every unread row of
  // every type, run-out snoozes and failed sends included). Mentions, Briefs
  // and Plans mark every matching row on the server, loaded or not, 500 ids
  // per inbox_mark_read_ids call (markChipRead); a failure part way reloads
  // the list, so only the rows that did not save show unread again. Then the
  // Mentions count and the nav badge refetch. Upcoming has no targets.
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

  // Mark all read belongs to the chips: none while a search hides them.
  const chipUnread = useMemo(
    () => (searching ? 0 : markAllTargets(items, state, nowMs).length),
    [items, state, nowMs, searching],
  );

  // Optimistic snooze: flip the row's snoozed_until locally first, then call the
  // proc; on failure revert and surface the error (matches handleMarkRead).
  const handleSnooze = useCallback(
    (item: ActivityItem, kind: SnoozeKind) => {
      if (workspaceId === null) return;
      const previous = item.snoozedUntil;
      const next = optimisticSnoozeUntil(kind, Date.now());
      editItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, snoozedUntil: next } : i)));
      const traceId = newTrace();
      void snoozeEntry(supabase, item, workspaceId, kind, traceId).then((result) => {
        if (!result.ok) {
          editItems((prev) =>
            prev.map((i) => (i.id === item.id ? { ...i, snoozedUntil: previous } : i)),
          );
          logger.warn('notifications: snooze failed', {
            trace_id: traceId,
            error: result.error.message,
          });
          push(errorText('snooze', result.error));
          return;
        }
        window.dispatchEvent(new CustomEvent('sorted:inbox-changed'));
      });
    },
    [workspaceId, newTrace, editItems, push],
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
  // own trace id; a failure toasts "Couldn't do that. {reason}" (a "not
  // found" stays silent) and the rows reload.
  const upcomingFailed = useCallback(
    (
      what: string,
      traceId: string,
      message: string,
      copy: string | null = errorText('do that', message),
    ) => {
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
  if (!listLoading) mark('activity:paint');
  // What the first frame painted (?paintlog): the kept or device-saved page,
  // or the loading line (nothing saved for this chip and sort yet).
  const firstPaintRef = useRef<string | null>(null);
  const keptOnScreen = state === 'upcoming' ? upcomingLoaded : !listLoading;
  firstPaintRef.current ??= keptOnScreen ? 'activity:kept-paint' : 'activity:loading-paint';
  useLayoutEffect(() => {
    if (firstPaintRef.current !== null) mark(firstPaintRef.current);
  }, []);
  useKeptScroll(keptKey('scroll'), state === 'upcoming' ? upcomingLoaded : !listLoading);
  // Boxes only while nothing is held for the list; the cards settle once when
  // they land after them (a kept or device-saved page paints at once).
  const hadBoxes = useHadBoxes(
    state !== 'upcoming' && listLoading && !(error && items.length === 0),
  );
  useSettleOnLanding(listRef, !listLoading, hadBoxes);

  return (
    <>
      {/* No visible title (as Pipeline, Briefs, Assets and Plan): the page starts with the
          search row. The h1 stays for screen readers and e2e. */}
      <h1 tabIndex={-1} className="sr-only">
        {ACTIVITY_TITLE}
      </h1>

      {/* The shared list header: search left, sort right. */}
      <SectionHeader<ActivityDirection>
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search activity',
          label: 'Search activity',
        }}
        sort={{
          node: (
            <SortMenu<ActivityDirection>
              options={activitySortOptions(searching)}
              value={sort}
              onChange={setSort}
              label="Sort activity"
            />
          ),
        }}
      />

      {searching ? null : (
        <ActivityFilterBar
          state={state}
          onStateChange={setState}
          totalUnread={totalUnread}
          mentionCount={mentionCount}
        />
      )}

      {state === 'upcoming' && !searching ? (
        upcomingError ? (
          <LoadFailed onRetry={() => void loadUpcoming()} />
        ) : workspaceId === null || !upcomingLoaded ? (
          <UpcomingBoxes />
        ) : visibleUpcoming.length === 0 ? (
          <EmptyState icon={<IconCalendarClock size={ICON_SIZE.status} />} title={UPCOMING_EMPTY} />
        ) : (
          <div data-upcoming-list="" className={cn('mt-4 pb-6', LIST_CARD_GRID, GUTTER)}>
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
      ) : error && items.length === 0 ? (
        <LoadFailed onRetry={() => (searching ? activitySearch.refresh() : void loadActivity())} />
      ) : listLoading ? (
        <ActivityBoxes />
      ) : buckets.length === 0 ? (
        searching ? (
          <NoResults
            query={activitySearch.query}
            filtersActive={false}
            onClear={() => setSearch('')}
          />
        ) : state === 'mentions' ? (
          <EmptyState icon={<IconAt size={ICON_SIZE.status} />} title={EMPTY_LINES.mentions} />
        ) : state === 'briefs' ? (
          <EmptyState icon={<IconBriefs size={ICON_SIZE.status} />} title={EMPTY_LINES.briefs} />
        ) : state === 'plans' ? (
          <EmptyState icon={<IconPlan size={ICON_SIZE.status} />} title={EMPTY_LINES.plans} />
        ) : state === 'snoozed' ? (
          <EmptyState
            icon={<IconAlarmClock size={ICON_SIZE.status} />}
            title={EMPTY_LINES.snoozed}
          />
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
                {/* One 44 line on the page edge: "YESTERDAY · 1 update" left and, on the
                    first day only, Mark all read right (the toolbar keeps one IconButton,
                    Sort; the Unread chip already shows the count). The line is 44 with or
                    without the link, so the list never shifts when it goes. */}
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
                  {bucketIndex === 0 && chipUnread > 0 ? (
                    // L6: the link's own 8 inset is pulled out so its text ends on the edge.
                    <div
                      data-activity-mark-all=""
                      className="-mr-2 ml-auto flex shrink-0 justify-end"
                    >
                      <Button variant="link" onClick={handleMarkAll}>
                        Mark all read
                      </Button>
                    </div>
                  ) : null}
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
                        onSnooze={handleSnooze}
                        onMarkRead={handleMarkRead}
                        selfName={selfName}
                        side={side}
                        onRetry={handleRetry}
                        onEdit={handleEdit}
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
            <Button type="button" variant="ghost" onClick={() => setCancelTarget(null)}>
              Keep
            </Button>
            <Button
              type="button"
              variant="danger"
              data-confirm-cancel-upcoming=""
              onClick={confirmCancel}
            >
              {cancelShown?.kind === 'scheduled' ? DONT_SEND_LABEL : CANCEL_REMINDER_LABEL}
            </Button>
          </div>
        }
      >
        <p className="truncate text-base text-fg-2">{cancelShown?.preview ?? ''}</p>
      </Sheet>
    </>
  );
}
