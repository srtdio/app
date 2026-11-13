// Catch up per tab (13 Nov 2026): a list tab's catch-up rows (ui/ListCard
// solid + count, one per kind, only while its count is above 0) and the
// EXISTING CatchUpScreen its tap opens, holding only that row's kind, newest
// first (the tab's own path + ?catchup=<kind>; Back returns to the tab).
//
// Mark all read for one row: phone, swipe the row left (X only, the shared
// swipe core) past the trigger; laptop, a "Mark N as read" Tool button left
// of the count on hover or keyboard focus. No toast, no Undo.
//
// Pure render from the shared store (lib/catch-up/tab-store): no await, hold,
// gate or read on paint. A row that lands after the first paint slides in
// (src/lib/motion itemIn, translateY; instant under Reduce Motion); nothing
// is reserved at 0.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import {
  IconBank,
  IconBriefs,
  IconChat,
  IconPipeline,
  IconPlan,
  type IconProps,
} from '@/components/ui/icons';
import { LIST_CARD_SOLID_GROUP, ListCard } from '@/components/ui/ListCard';
import { textRole } from '@/components/ui/Text';
import { CatchUpScreen } from '@/components/catch-up/CatchUpScreen';
import {
  editKeptActivityPages,
  fetchActivityEntry,
  type ActivityItem,
} from '@/components/pages/activity/data';
import { createSwipeReplyController, type SwipeReplyController } from '@/lib/chat/swipe-reply';
import { mentionHandle } from '@/lib/chat/mentions';
import { useViewerSide } from '@/lib/chat/viewer-role';
import type { ConversationSummary } from '@/lib/chat/chat-store';
import type { ThreadForMeAll } from '@/lib/chat/thread-signals';
import { cn } from '@/lib/cn';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { logger } from '@/lib/logger';
import { itemIn, paintSwipe } from '@/lib/motion';
import { mark } from '@/lib/perf-marks';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useCurrentProfile } from '@/lib/use-current-profile';
import { useIsLaptop, usePrefersReducedMotion } from '@/lib/use-is-laptop';
import { useWorkspace } from '@/lib/workspace-context';
import { buildCatchUpQueue, type CatchUpItem } from '@/lib/catch-up/queue';
import { takeCatchUpSeed } from '@/lib/catch-up/route';
import { patchThreadUnread } from '@/lib/catch-up/threads';
import { onCatchUpItem } from '@/lib/catch-up/use-catch-up';
import { markCatchUpRead } from '@/lib/catch-up/writes';
import {
  TAB_CATCH_UP_ENTRY_PARAM,
  TAB_CATCH_UP_PARAM,
  TAB_CATCH_UP_TITLE,
  chatCards,
  dropHeldEntries,
  heldEntriesOf,
  isTabCatchUpKind,
  itemKindsOf,
  markHeldRead,
  markNAsRead,
  restoreHeldEntries,
  tabCatchUpLine,
  tabCounts,
  tabQueue,
  useHeldKnown,
  useHeldUnread,
  useInboxCards,
  type TabCatchUpKind,
} from '@/lib/catch-up/tab-store';

/** Each row's icon: the tab's own nav icon; Concept = the bank. */
export const TAB_CATCH_UP_ICON: Readonly<Record<TabCatchUpKind, ComponentType<IconProps>>> = {
  post: IconPipeline,
  brief: IconBriefs,
  'plan-item': IconPlan,
  idea: IconBank,
  chat: IconChat,
};

/** A row's accessible name: "<Name>, N unread". Pure. */
export function tabCatchUpLabel(tab: TabCatchUpKind, count: number): string {
  return `${TAB_CATCH_UP_TITLE[tab]}, ${tabCatchUpLine(count)}`;
}

/** The chat data Chat catch up adds (ChannelList holds it; other tabs pass nothing). */
export interface TabCatchUpChat {
  threads: readonly ThreadForMeAll[] | null;
  /** The chat store's conversations once it is ready; null before. */
  conversations: Readonly<Record<string, ConversationSummary>> | null;
  /** Zero a chat's unread in the store (a card or a row marked it read). */
  markConversationRead: (channelId: string) => void;
}

/** The phone swipe: left only, touch and pen, past the trigger marks the row read. */
function useRowSwipe(
  sliderRef: RefObject<HTMLElement>,
  iconRef: RefObject<HTMLSpanElement>,
  onMark: () => void,
  onBegin: () => void,
): {
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
  };
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
} {
  const latest = useRef(onMark);
  latest.current = onMark;
  const begin = useRef(onBegin);
  begin.current = onBegin;
  const reducedMotion = usePrefersReducedMotion();
  const reduced = useRef(reducedMotion);
  reduced.current = reducedMotion;
  const ref = useRef<SwipeReplyController | null>(null);
  if (ref.current === null) {
    ref.current = createSwipeReplyController({
      direction: 'left',
      onReply: () => latest.current(),
      onFrame: (frame) => paintSwipe(sliderRef.current, iconRef.current, frame, 'left'),
      onStart: (pointerId) => {
        begin.current();
        if (pointerId === undefined) return;
        try {
          sliderRef.current?.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; the gesture ends on its own.
        }
      },
      reducedMotion: () => reduced.current,
    });
  }
  const swipe = ref.current;
  useEffect(() => () => swipe.dispose(), [swipe]);
  return {
    handlers: {
      onPointerDown: (e) => swipe.handlers.onPointerDown(e),
      onPointerMove: (e) => swipe.handlers.onPointerMove(e),
      onPointerUp: (e) => swipe.handlers.onPointerUp(e),
      onPointerCancel: () => swipe.handlers.onPointerCancel(),
    },
    onClickCapture: (e) => {
      if (!swipe.consumeClickSuppression()) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** Where the hover key or the swipe word sits: over one row, measured in the rows' box. */
interface RowSpot {
  tab: TabCatchUpKind;
  top: number;
  height: number;
  /** The key's right edge: 8 left of the count pill. */
  right: number;
}

/** A row's box in the rows' box (the layer the swipe word and the hover key sit in). */
function spotOf(tab: TabCatchUpKind, row: HTMLElement, box: HTMLElement): RowSpot {
  const r = row.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const pill = row.querySelector('[data-list-card-count]')?.getBoundingClientRect();
  return {
    tab,
    top: r.top - b.top,
    height: r.height,
    right: pill !== undefined ? b.right - pill.left + 8 : 0,
  };
}

/**
 * One row: the solid ListCard itself, a direct cell of the solid group (so the
 * part's corners and seam stay its own). Phone: the swipe moves the row on X
 * (its root); the word behind it is the rows' layer. Laptop: hover or focus
 * asks the rows for the Mark N as read key.
 */
function TabCatchUpRow(props: {
  tab: TabCatchUpKind;
  count: number;
  laptop: boolean;
  /** The row came after the first paint: it slides in. */
  late: boolean;
  word: RefObject<HTMLSpanElement>;
  box: RefObject<HTMLDivElement>;
  onOpen: () => void;
  onMarkRead: () => void;
  onHover: (spot: RowSpot | null, leaving: EventTarget | null) => void;
}): ReactElement {
  const { tab, count, laptop, word, box, onHover } = props;
  const rowRef = useRef<HTMLElement>(null);
  const swipe = useRowSwipe(rowRef, word, props.onMarkRead, () => {
    // The word sits behind this row while it moves.
    const row = rowRef.current;
    const el = word.current;
    const layer = box.current;
    if (row === null || el === null || layer === null) return;
    const spot = spotOf(tab, row, layer);
    el.style.top = `${spot.top}px`;
    el.style.height = `${spot.height}px`;
  });
  const late = useRef(props.late);
  useLayoutEffect(() => {
    if (late.current) itemIn(rowRef.current);
  }, []);
  const show = (): void => {
    const row = rowRef.current;
    const layer = box.current;
    if (row !== null && layer !== null) onHover(spotOf(tab, row, layer), null);
  };
  const surface = laptop
    ? {
        onPointerEnter: show,
        onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => onHover(null, e.relatedTarget),
        onFocus: show,
        onBlur: (e: ReactFocusEvent<HTMLElement>) => onHover(null, e.relatedTarget),
      }
    : {
        ...swipe.handlers,
        onClickCapture: swipe.onClickCapture,
      };
  return (
    <ListCard
      solid
      unread
      count={count}
      rootRef={rowRef}
      surface={surface}
      data-tab-catch-up={tab}
      data-count={String(count)}
      picture={{ kind: 'icon', icon: TAB_CATCH_UP_ICON[tab] }}
      title={TAB_CATCH_UP_TITLE[tab]}
      preview={tabCatchUpLine(count)}
      onPress={props.onOpen}
      press={{
        'aria-label': tabCatchUpLabel(tab, count),
        'data-tab-catch-up-open': tab,
        'data-count': String(count),
      }}
    />
  );
}

/**
 * The rows of one tab (in order), only those above 0; null when none. The
 * rows sit straight in the solid group (ListCard cells); one layer around
 * them holds each row's swipe word (behind the rows) and the laptop's
 * Mark N as read key (over the hovered row, left of its count).
 */
export function TabCatchUpRows(props: {
  tabs: readonly TabCatchUpKind[];
  counts: Readonly<Record<TabCatchUpKind, number>>;
  onOpen: (tab: TabCatchUpKind) => void;
  onMarkRead: (tab: TabCatchUpKind) => void;
  /** The tab painted before these rows landed: a new row slides in. */
  late?: boolean;
}): ReactElement | null {
  const laptop = useIsLaptop();
  const boxRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLSpanElement>(null);
  const words = useRef(new Map<TabCatchUpKind, RefObject<HTMLSpanElement>>());
  const wordOf = (tab: TabCatchUpKind): RefObject<HTMLSpanElement> => {
    let ref = words.current.get(tab);
    if (ref === undefined) {
      ref = { current: null };
      words.current.set(tab, ref);
    }
    return ref;
  };
  const [spot, setSpot] = useState<RowSpot | null>(null);
  const onHover = useCallback((next: RowSpot | null, leaving: EventTarget | null) => {
    // Moving from the row onto its key (or back) keeps the key.
    if (next === null && leaving instanceof Node && keyRef.current?.contains(leaving) === true) {
      return;
    }
    setSpot(next);
  }, []);
  const shown = props.tabs.filter((tab) => props.counts[tab] > 0);
  if (shown.length === 0) return null;
  const spotCount = spot !== null ? props.counts[spot.tab] : 0;
  const keyStyle: CSSProperties | undefined =
    spot !== null ? { top: spot.top, height: spot.height, right: spot.right } : undefined;
  return (
    <div ref={boxRef} data-tab-catch-up-rows="" className="relative">
      {laptop
        ? null
        : shown.map((tab) => (
            <span
              key={tab}
              ref={wordOf(tab)}
              aria-hidden="true"
              data-tab-catch-up-swipe={tab}
              className={textRole('label', 'absolute right-0 top-0 flex items-center opacity-0')}
            >
              {markNAsRead(props.counts[tab])}
            </span>
          ))}
      {/* Phone: a sideways move is the rows' swipe, an up-down one the page's scroll. */}
      <div className={cn(LIST_CARD_SOLID_GROUP, !laptop && 'touch-pan-y touch-pinch-zoom')}>
        {shown.map((tab) => (
          <TabCatchUpRow
            key={tab}
            tab={tab}
            count={props.counts[tab]}
            laptop={laptop}
            late={props.late === true}
            word={wordOf(tab)}
            box={boxRef}
            onOpen={() => props.onOpen(tab)}
            onMarkRead={() => props.onMarkRead(tab)}
            onHover={onHover}
          />
        ))}
      </div>
      {laptop && spot !== null && spotCount > 0 ? (
        <span
          ref={keyRef}
          data-tab-catch-up-mark={spot.tab}
          className="absolute flex items-center"
          style={keyStyle}
          onPointerLeave={(e) => {
            const to = e.relatedTarget;
            if (to instanceof Node && boxRef.current?.contains(to) === true) return;
            setSpot(null);
          }}
        >
          <Button
            type="button"
            variant="ghost"
            className="text-accent-fg"
            onClick={() => {
              const tab = spot.tab;
              setSpot(null);
              props.onMarkRead(tab);
            }}
          >
            {markNAsRead(spotCount)}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The card stack for one row (?catchup=<kind>[&entry=<id>]): mounted only
 * while the URL names it. The queue is fixed when it opens: the named entry's
 * item first (an old Activity link), then the row's cards newest first.
 */
function TabCatchUpStack(props: {
  kind: TabCatchUpKind;
  entry: string | null;
  userId: string;
  workspaceId: string;
  held: readonly ActivityItem[];
  cards: readonly CatchUpItem[];
  onClose: () => void;
}): ReactElement | null {
  const { kind, entry, userId, workspaceId } = props;
  const navigate = useNavigate();
  const { workspaceKey, workspaces } = useWorkspace();
  const tz = workspaces.find((row) => row.id === workspaceId)?.timezone ?? null;
  const { profile } = useCurrentProfile();
  const { side } = useViewerSide(workspaceId);
  const selfName =
    profile != null
      ? mentionHandle({ displayName: profile.display_name, username: profile.username })
      : null;
  const heldReady = useHeldKnown();
  const [queue, setQueue] = useState<CatchUpItem[] | null>(null);
  const fetching = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    // The queue waits for the held copy (a cold session's first open); never a paint gate.
    if (queue !== null || !heldReady) return;
    const fix = (tapped: ActivityItem | null, follow: readonly ActivityItem[] = []): void => {
      mark('catch-up:queue');
      const { held, cards } = latest.current;
      const first =
        tapped === null
          ? []
          : buildCatchUpQueue({
              tapped,
              held,
              follow,
              nowMs: Date.now(),
              workspaceId,
              selfId: userId,
              kinds: itemKindsOf(kind),
            });
      const firstKey = first[0]?.key ?? null;
      const rest = tabQueue(cards, kind).filter((card) => card.key !== firstKey);
      setQueue([...first.slice(0, 1), ...rest]);
    };
    if (entry === null) {
      fix(null);
      return;
    }
    const seed = takeCatchUpSeed(entry);
    if (seed !== undefined) {
      fix(seed.item, seed.follow);
      return;
    }
    const known = latest.current.held.find((item) => item.id === entry);
    if (known !== undefined) {
      fix(known);
      return;
    }
    if (fetching.current) return;
    fetching.current = true;
    void fetchActivityEntry(supabase, workspaceId, entry).then((res) => {
      if (!res.ok) logger.warn('catch-up: entry read failed', { error: res.error });
      fix(res.ok ? res.data : null);
    });
  }, [queue, heldReady, entry, kind, userId, workspaceId]);

  const openPlace = useCallback(
    (href: string) => {
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      navigate(href, { replace: true });
    },
    [navigate],
  );
  const setRead = useCallback(
    (ids: readonly string[], read: boolean) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      const stamp = new Date().toISOString();
      editKeptActivityPages(userId, workspaceId, (items) =>
        items.map((item) =>
          set.has(item.id) ? { ...item, readAt: read ? (item.readAt ?? stamp) : null } : item,
        ),
      );
      if (read) dropHeldEntries(ids);
      else
        restoreHeldEntries(
          (queue ?? []).flatMap((card) => card.entries.filter((e) => set.has(e.id))),
        );
    },
    [userId, workspaceId, queue],
  );
  const onRead = useCallback((ids: readonly string[]) => setRead(ids, true), [setRead]);
  const onUnread = useCallback((ids: readonly string[]) => setRead(ids, false), [setRead]);
  const onAllRead = useCallback(() => {
    window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
  }, []);
  // Nothing to catch up on: the param goes.
  const empty = queue !== null && queue.length === 0;
  const { onClose } = props;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  if (queue === null || queue.length === 0) return null;
  return (
    <CatchUpScreen
      queue={queue}
      workspaceId={workspaceId}
      workspaceKey={workspaceKey}
      currentUserId={userId}
      selfName={selfName}
      side={side}
      timeZone={tz ?? undefined}
      onClose={onClose}
      onOpenPlace={openPlace}
      onRead={onRead}
      onUnread={onUnread}
      onAllRead={onAllRead}
    />
  );
}

/**
 * A tab's catch up: its rows (for ListScreen's catchUp slot; null when every
 * count is 0) and, while the URL says ?catchup=<kind>, the card stack. The
 * page passes the user and workspace it already holds: no context of its own
 * on the paint path.
 */
export function useTabCatchUp(input: {
  tabs: readonly TabCatchUpKind[];
  userId: string | null;
  workspaceId: string | null;
  chat?: TabCatchUpChat;
}): { rows: ReactElement | null; screen: ReactElement | null } {
  const [searchParams, setSearchParams] = useSearchParams();
  const { userId, workspaceId } = input;
  const held = useHeldUnread(userId, workspaceId);
  const inbox = useInboxCards(userId, workspaceId);
  const chat = input.chat;
  const threads = chat?.threads ?? null;
  const conversations = chat?.conversations ?? null;
  const hasChat = chat !== undefined;
  const cards = useMemo(() => {
    if (workspaceId === null) return [];
    const plain = inbox.filter((card) => card.kind !== 'chat-main' && card.kind !== 'chat-thread');
    if (!hasChat) return plain;
    return [...plain, ...chatCards({ inbox, threads, conversations, workspaceId, selfId: userId })];
  }, [inbox, threads, conversations, workspaceId, userId, hasChat]);
  const counts = useMemo(() => tabCounts(cards), [cards]);

  // A chat card read in the stack: its chat (or thread) reads as read at once.
  const markConversationRead = chat?.markConversationRead;
  useEffect(() => {
    if (!hasChat) return undefined;
    return onCatchUpItem((item, read) => {
      if (item.kind === 'chat-thread' && item.threadRootId !== null) {
        patchThreadUnread(item.workspaceId, item.entityId, item.threadRootId, !read);
      }
      if (read && item.kind === 'chat-main') markConversationRead?.(item.entityId);
    });
  }, [hasChat, markConversationRead]);

  const open = useCallback(
    (tab: TabCatchUpKind) => {
      const next = new URLSearchParams(searchParams);
      next.set(TAB_CATCH_UP_PARAM, tab);
      next.delete(TAB_CATCH_UP_ENTRY_PARAM);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  // A row's Mark N as read: every card of that kind read, no toast, no Undo.
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const markRow = useCallback(
    (tab: TabCatchUpKind) => {
      const row = tabQueue(cardsRef.current, tab);
      if (row.length === 0 || workspaceId === null) return;
      const entries = heldEntriesOf(row);
      if (userId !== null) {
        const ids = new Set(entries.map((e) => e.id));
        const stamp = new Date().toISOString();
        editKeptActivityPages(userId, workspaceId, (items) =>
          items.map((item) =>
            ids.has(item.id) ? { ...item, readAt: item.readAt ?? stamp } : item,
          ),
        );
      }
      if (tab !== 'chat') {
        markHeldRead(entries);
        return;
      }
      // Chat: each card's read point too (the main chat's cursor, the thread's read).
      dropHeldEntries(entries.map((e) => e.id));
      const traceId = generateTraceId();
      for (const item of row) {
        if (item.kind === 'chat-main') markConversationRead?.(item.entityId);
        if (item.kind === 'chat-thread' && item.threadRootId !== null) {
          patchThreadUnread(item.workspaceId, item.entityId, item.threadRootId, false);
        }
      }
      void Promise.all(
        row.map((item) => markCatchUpRead(supabase, { workspaceId, item, traceId })),
      ).then((results) => {
        const failed = results.find((r) => !r.ok);
        if (failed !== undefined && !failed.ok) {
          logger.warn('catch-up: row mark read failed', {
            trace_id: traceId,
            error: failed.message,
          });
          restoreHeldEntries(entries);
        }
        window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      });
    },
    [workspaceId, userId, markConversationRead],
  );

  // Rows that land after the tab's first paint slide in; the first frame never moves.
  const painted = useRef(false);
  useEffect(() => {
    painted.current = true;
  }, []);
  const rows = input.tabs.some((tab) => counts[tab] > 0) ? (
    <TabCatchUpRows
      tabs={input.tabs}
      counts={counts}
      onOpen={open}
      onMarkRead={markRow}
      late={painted.current}
    />
  ) : null;

  const close = useCallback(() => {
    window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    const next = new URLSearchParams(searchParams);
    next.delete(TAB_CATCH_UP_PARAM);
    next.delete(TAB_CATCH_UP_ENTRY_PARAM);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const param = searchParams.get(TAB_CATCH_UP_PARAM);
  const entry = searchParams.get(TAB_CATCH_UP_ENTRY_PARAM);
  const kind = isTabCatchUpKind(param) && input.tabs.includes(param) ? param : null;
  const screen =
    kind !== null && userId !== null && workspaceId !== null ? (
      <TabCatchUpStack
        key={`${kind}:${entry ?? ''}`}
        kind={kind}
        entry={entry}
        userId={userId}
        workspaceId={workspaceId}
        held={held}
        cards={cards}
        onClose={close}
      />
    ) : null;

  return { rows, screen };
}
