// The chat status ticker: a 36px bar under the thread header (in the slot the
// open-loops strip held) and the drawer it drops down. The bar lists, in one
// fixed order, the soonest-ending open plan, posts in review, open briefs and
// this chat's open commitments, decisions and pending marks; zero items are
// left out and the rest close up. Full width first; when the items do not fit
// (measured on a hidden copy before paint, again on resize and font load)
// every item drops its word together and the gap tightens: never a mix, never
// cut text, never a visible switch. Until every read has settled the slot is
// empty and inert, so the first painted bar is final; "Nothing open between
// you" shows only when every read succeeded with nothing open, never as a
// button. The drawer opens by a tap on the bar (top of the list), a tap on an
// item (scrolled to its section before paint) or a drag down; it closes by
// the scrim, a drag up on its handle, or another tap on the bar. It moves on
// translateY only, snapping at 40% of its height or a flick over 0.4 px/ms.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react';
import { IconCheck, IconChevronDown } from '@/components/ui/icons';
import {
  DrawerPostSheet,
  NO_CALLOUT,
  STATUS_ICON,
  StatusDrawerList,
  StatusDrawerPanel,
  type StatusDrawerActions,
  type StatusDrawerData,
} from '@/components/chat/StatusDrawer';
import { useThreadCardCache } from '@/components/chat/PostCard';
import { useToast } from '@/components/ui/toast';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { cn } from '@/lib/cn';
import {
  NOTHING_OPEN_LINE,
  SECTION_ROWS,
  STATUS_ORDER,
  drawerShouldClose,
  type StatusBar,
  type StatusItem,
  type StatusKey,
  type StatusTone,
} from '@/lib/chat/status-bar';

/** Snap open past this share of the panel's height. */
export const SNAP_SHARE = 0.4;
/** A flick faster than this (px/ms) snaps in its direction. */
export const FLICK_VELOCITY = 0.4;
/** Movement before a press becomes a drag (px). */
const DRAG_SLOP = 6;
/** The open and close motion (ms); the panel unmounts after it. */
export const DRAWER_MS = 220;

const NUMBER_TONE: Record<StatusTone, string> = {
  default: 'text-fg',
  warn: 'text-warn',
  good: 'text-good',
};
const ICON_TONE: Record<StatusTone, string> = {
  default: 'text-fg-2',
  warn: 'text-warn',
  good: 'text-good',
};

/** Room full mode keeps between the last item and the chevron (px). */
const FULL_CHEVRON_GAP = 12;

const BAR =
  'relative z-10 flex h-9 w-full shrink-0 items-center border-b border-border bg-panel px-4';

/** One bar item; compact drops the word and the "+K" (the plan keeps "Plan"). */
function TickerItem(props: {
  item: StatusItem;
  compact: boolean;
  measure?: boolean;
}): ReactElement {
  const { item, compact } = props;
  const Icon = STATUS_ICON[item.key];
  const parts = (
    <>
      <Icon size={16} className={cn('shrink-0', ICON_TONE[item.tone])} />
      {item.lead !== null ? <span>{item.lead}</span> : null}
      <span
        data-status-number=""
        className={cn(
          'font-mono font-semibold tabular-nums',
          compact && 'tracking-tighter',
          NUMBER_TONE[item.tone],
        )}
      >
        {item.number}
      </span>
      {!compact && item.word !== null ? <span data-status-word="">{item.word}</span> : null}
      {!compact && item.more > 0 ? (
        <span data-status-more="" className="font-mono font-semibold tabular-nums text-fg-3">
          {`+${item.more}`}
        </span>
      ) : null}
    </>
  );
  const box = 'flex h-9 shrink-0 items-center gap-1 whitespace-nowrap text-xs leading-4 text-fg-2';
  if (props.measure === true) return <span className={box}>{parts}</span>;
  return (
    <button
      type="button"
      data-status-item={item.key}
      aria-label={item.aria}
      className={cn(
        box,
        // The 44px tap target: 4px above and below, half the gap each side.
        "relative before:absolute before:-inset-y-1 before:content-['']",
        compact ? 'before:-inset-x-1' : 'before:-inset-x-1.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      {parts}
    </button>
  );
}

/** Whether the full items overflow their area. Pure (given the two widths). */
export function needsCompact(fullWidth: number, available: number): boolean {
  return available > 0 && fullWidth > available;
}

/**
 * The bar alone (no drawer). `bar` null is the inert empty slot while reads
 * settle; 'blank' is a bar with nothing it can claim (a read failed).
 */
export function StatusTickerBar(props: {
  bar: StatusBar | null;
  open?: boolean;
  barRef?: (el: HTMLDivElement | null) => void;
  onBarClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}): ReactElement {
  const { bar } = props;
  const items = bar !== null && bar.kind === 'items' ? bar.items : null;
  const [compact, setCompact] = useState(false);
  const [sizeTick, setSizeTick] = useState(0);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const itemsKey =
    items?.map((i) => `${i.key}:${i.lead ?? ''}${i.number}:${i.word ?? ''}:${i.more}`).join('|') ??
    '';

  // Before paint: the full row's width against the room it has.
  useLayoutEffect(() => {
    const area = areaRef.current;
    const measure = measureRef.current;
    if (area === null || measure === null) return;
    // Full mode keeps a 12px space before the chevron (the area's right padding).
    setCompact(needsCompact(measure.offsetWidth + FULL_CHEVRON_GAP, area.clientWidth));
  }, [itemsKey, sizeTick]);

  // Re-measure on resize and when web fonts land.
  useEffect(() => {
    if (items === null) return;
    const bump = (): void => setSizeTick((t) => t + 1);
    const area = areaRef.current;
    const observer =
      typeof ResizeObserver !== 'undefined' && area !== null ? new ResizeObserver(bump) : null;
    if (observer !== null && area !== null) observer.observe(area);
    window.addEventListener('resize', bump);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', bump);
    void fonts?.ready.then(bump, () => undefined);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', bump);
      fonts?.removeEventListener?.('loadingdone', bump);
    };
  }, [items === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (bar === null || bar.kind === 'blank') {
    return (
      <div
        data-loops-strip={bar === null ? 'pending' : 'unknown'}
        aria-hidden="true"
        className={cn(BAR, NO_CALLOUT)}
      />
    );
  }
  if (bar.kind === 'empty') {
    return (
      <div
        data-loops-strip="empty"
        data-status-ticker="empty"
        className={cn(BAR, 'gap-1 text-xs leading-4 text-fg-3', NO_CALLOUT)}
      >
        <IconCheck size={16} className="shrink-0 text-fg-3" />
        <span>{NOTHING_OPEN_LINE}</span>
      </div>
    );
  }
  const open = props.open === true;
  return (
    <div
      ref={props.barRef}
      data-loops-strip="open"
      data-status-ticker={compact ? 'compact' : 'full'}
      role="group"
      aria-label="Open in this chat"
      onClick={props.onBarClick}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(BAR, 'cursor-pointer [touch-action:none]', NO_CALLOUT)}
    >
      <div
        ref={areaRef}
        data-status-items=""
        className={cn(
          'relative flex min-w-0 flex-1 items-center',
          compact ? 'gap-2' : 'gap-3 pr-3',
        )}
      >
        {items?.map((item) => (
          <TickerItem key={item.key} item={item} compact={compact} />
        ))}
        <div
          ref={measureRef}
          aria-hidden="true"
          data-status-measure=""
          className="pointer-events-none invisible absolute left-0 top-0 flex w-max gap-3"
        >
          {items?.map((item) => (
            <TickerItem key={item.key} item={item} compact={false} measure />
          ))}
        </div>
      </div>
      <button
        type="button"
        data-status-chevron=""
        aria-label={open ? 'Hide open items' : 'Show open items'}
        aria-expanded={open}
        className="relative flex h-9 w-4 shrink-0 items-center justify-center text-fg-3 before:absolute before:-inset-x-3.5 before:-inset-y-1 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          data-status-chevron-icon={open ? 'up' : 'down'}
          className="flex transition-transform duration-200 motion-reduce:transition-none"
          style={open ? { transform: 'rotate(180deg)' } : undefined}
        >
          <IconChevronDown size={16} />
        </span>
      </button>
    </div>
  );
}

/** Where the drawer was when the chat navigated away (a brief, the Briefs page). */
export interface DrawerMemory {
  /** The router location key the chat was at when it left. */
  locationKey: string;
  scrollTop: number;
  postsExpanded: boolean;
}

/** Per channel; a Back to the same history entry restores it, any other arrival drops it. */
const drawerMemory = new Map<string, DrawerMemory>();

/** Test hook: forget every remembered drawer. */
export function resetDrawerMemory(): void {
  drawerMemory.clear();
}

/** Remember the drawer as the chat leaves; no location key (no router) remembers nothing. */
export function rememberDrawer(
  channelId: string,
  locationKey: string | undefined,
  state: { scrollTop: number; postsExpanded: boolean },
): void {
  if (locationKey === undefined || locationKey === '') return;
  drawerMemory.set(channelId, { locationKey, ...state });
}

/**
 * The chat mounted at `mountKey`: the channel's memory is taken (removed) and
 * returned only when it was saved at that same key (Back to the same history
 * entry); any other arrival drops it and the drawer starts closed.
 */
export function takeDrawerMemory(
  channelId: string,
  mountKey: string | undefined,
): DrawerMemory | null {
  const remembered = drawerMemory.get(channelId);
  if (remembered === undefined) return null;
  drawerMemory.delete(channelId);
  return mountKey !== undefined && remembered.locationKey === mountKey ? remembered : null;
}

/** The copy when a tapped post cannot be opened. */
export const POST_OPEN_FAILED = "Couldn't open this post";

/** How long a tapped post may wait on its read before the tap gives up (ms). */
export const POST_TAP_WAIT_MS = READ_TIMEOUT_MS + 1_000;

/**
 * What a post row tap does with the card cache's snapshot of that post: open
 * the sheet, wait on the read in flight, or say it cannot (a failed read, or
 * a post RLS hides). Pure.
 */
export function postTapOutcome(
  snapshot: { loading: boolean; posts: ReadonlyArray<{ id: string }>; failed: readonly string[] },
  postId: string,
): 'open' | 'pending' | 'failed' | 'not_visible' {
  if (snapshot.posts.some((p) => p.id === postId)) return 'open';
  if (snapshot.failed.includes(postId)) return 'failed';
  if (snapshot.loading) return 'pending';
  return 'not_visible';
}

/** The slice of the thread card cache a post tap uses. */
export interface PostTapCache {
  posts: (ids: readonly string[]) => {
    loading: boolean;
    posts: ReadonlyArray<{ id: string }>;
    failed: string[];
  };
  request: (ids: { postIds?: readonly string[] }) => void;
  retry: (ids: { postIds?: readonly string[] }) => void;
}

/**
 * A post row tap: open at once when the post is cached; else ask the cache
 * (a fresh try for a read that gave up) and wait busy; a post RLS hides says
 * so at once. No cache at all cannot open.
 */
export function tapPost(cache: PostTapCache | null, postId: string): 'open' | 'busy' | 'toast' {
  if (cache === null) return 'toast';
  const outcome = postTapOutcome(cache.posts([postId]), postId);
  if (outcome === 'open') return 'open';
  if (outcome === 'not_visible') return 'toast';
  if (outcome === 'failed') cache.retry({ postIds: [postId] });
  else cache.request({ postIds: [postId] });
  return 'busy';
}

/** A busy post after a cache change: open, still waiting (null), or toast. */
export function settleBusyPost(cache: PostTapCache, postId: string): 'open' | 'toast' | null {
  const outcome = postTapOutcome(cache.posts([postId]), postId);
  if (outcome === 'pending') return null;
  return outcome === 'open' ? 'open' : 'toast';
}

/** Ask the cache, in one batch, for every post the open drawer renders. */
export function prefetchPosts(
  cache: Pick<PostTapCache, 'request'> | null,
  open: boolean,
  postIds: readonly string[],
): void {
  if (!open || postIds.length === 0 || cache === null) return;
  cache.request({ postIds });
}

/** The post ids the Posts section renders right now (first five, or all once expanded). Pure. */
export function renderedPostIds(rows: ReadonlyArray<{ id: string }>, expanded: boolean): string[] {
  return (expanded ? rows : rows.slice(0, SECTION_ROWS)).map((r) => r.id);
}

/**
 * What a tap on the bar does: close an open drawer; else open it at the
 * tapped item's section (null: anywhere else on the bar, the top). Pure.
 */
export function barTap(
  open: boolean,
  target: {
    closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null;
  },
): { action: 'close' } | { action: 'open'; section: StatusKey | null } {
  if (open) return { action: 'close' };
  const item = target.closest?.('[data-status-item]') ?? null;
  const key = item?.getAttribute('data-status-item') ?? null;
  const section = STATUS_KEYS.has(key ?? '') ? (key as StatusKey) : null;
  return { action: 'open', section };
}

const STATUS_KEYS: ReadonlySet<string> = new Set(STATUS_ORDER);

/** Where a release lands: open or closed. Pure. */
export function snapOpen(input: {
  /** The panel's visible height now (0 closed .. height open). */
  offset: number;
  height: number;
  /** Last pointer velocity, px/ms (down is positive). */
  velocity: number;
}): boolean {
  if (input.velocity > FLICK_VELOCITY) return true;
  if (input.velocity < -FLICK_VELOCITY) return false;
  const height = Math.max(1, input.height);
  return input.offset >= height * SNAP_SHARE;
}

/** Whether a close released from open snaps shut: 40% of the travel. Pure. */
export function snapShut(input: { offset: number; height: number; velocity: number }): boolean {
  if (input.velocity < -FLICK_VELOCITY) return true;
  if (input.velocity > FLICK_VELOCITY) return false;
  const height = Math.max(1, input.height);
  return height - input.offset >= height * SNAP_SHARE;
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface Gesture {
  source: 'bar' | 'handle';
  pointerId: number;
  y0: number;
  base: number;
  moved: boolean;
  lastY: number;
  lastT: number;
  velocity: number;
  offset: number;
}

/** The ticker and its drawer, for one chat. */
export function ChatStatus(props: {
  channelId: string | undefined;
  /** null while reads settle (inert empty slot). */
  bar: StatusBar | null;
  drawer: StatusDrawerData;
  actions: Omit<StatusDrawerActions, 'onOpenPost' | 'onOpenBrief' | 'onSeeAllBriefs'>;
  /** In-app navigation (a brief, the Briefs page). */
  navigate: (to: string) => void;
  briefRoute: (id: string) => string;
  /** The router location key (absent outside a router: nothing is remembered). */
  locationKey?: string | undefined;
}): ReactElement {
  const { bar, channelId } = props;
  // The key this chat mounted at: memory restores only for that history entry.
  const mountKey = useRef(props.locationKey).current;
  const toast = useToast();
  const cardCache = useThreadCardCache();
  const interactive = bar !== null && bar.kind === 'items';
  const [shown, setShown] = useState(false);
  const [target, setTarget] = useState<'open' | 'closed'>('closed');
  const [entered, setEntered] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [animate, setAnimate] = useState(true);
  const [top, setTop] = useState(0);
  const [postsExpanded, setPostsExpanded] = useState(false);
  const [postSheet, setPostSheet] = useState<{ id: string; open: boolean } | null>(null);
  const scrollTo = useRef<{ section: StatusKey | null; scrollTop: number | null }>({
    section: null,
    scrollTop: null,
  });
  const barEl = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measureTop = (): void => {
    const el = barEl.current;
    if (el !== null) setTop(el.offsetTop + el.offsetHeight);
  };
  const panelHeight = (): number => panelRef.current?.offsetHeight ?? 0;

  const openAt = useCallback(
    (section: StatusKey | null, opts?: { instant?: boolean; scrollTop?: number }) => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      scrollTo.current = { section, scrollTop: opts?.scrollTop ?? null };
      measureTop();
      setAnimate(opts?.instant !== true && !reducedMotion());
      setDrag(null);
      setShown(true);
      setTarget('open');
      setEntered(opts?.instant === true);
    },
    [],
  );

  const close = useCallback((opts?: { instant?: boolean }) => {
    const instant = opts?.instant === true || reducedMotion();
    setAnimate(!instant);
    setDrag(null);
    setTarget('closed');
    setEntered(false);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    if (instant) {
      setShown(false);
      closeTimer.current = null;
      return;
    }
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setShown(false);
    }, DRAWER_MS + 40);
  }, []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  // Before paint: scroll to the asked section (or a remembered spot), then
  // let the panel slide in from there, so no scroll is ever seen.
  useLayoutEffect(() => {
    if (!shown || target !== 'open' || entered || drag !== null) return;
    const list = listRef.current;
    if (list !== null) {
      const { section, scrollTop } = scrollTo.current;
      if (scrollTop !== null) list.scrollTop = scrollTop;
      else if (section !== null) {
        const el = list.querySelector<HTMLElement>(`[data-status-section="${section}"]`);
        list.scrollTop = el !== null ? el.offsetTop - list.offsetTop : 0;
      } else list.scrollTop = 0;
    }
    // Commit the closed position first so the move to open transitions.
    panelRef.current?.getBoundingClientRect();
    setEntered(true);
  }, [shown, target, entered, drag]);

  // An instant (restored) open still needs its scroll put back.
  useLayoutEffect(() => {
    if (!shown || !entered || animate) return;
    const list = listRef.current;
    const remembered = scrollTo.current.scrollTop;
    if (list !== null && remembered !== null) {
      list.scrollTop = remembered;
      scrollTo.current = { section: null, scrollTop: null };
    }
  }, [shown, entered, animate]);

  // The last open thing closed while the drawer was open: the bar reads the
  // empty line and the drawer closes.
  useEffect(() => {
    if (shown && bar !== null && drawerShouldClose(bar)) close();
  }, [bar, shown, close]);

  // Back to the same history entry: the drawer comes back as it was left.
  // Any other arrival drops the memory on mount and the drawer starts closed.
  const restore = useRef<DrawerMemory | null | undefined>(undefined);
  useEffect(() => {
    // Taken once per mount (the ref survives StrictMode's effect replay).
    if (restore.current === undefined) {
      restore.current = channelId !== undefined ? takeDrawerMemory(channelId, mountKey) : null;
    }
    const remembered = restore.current;
    if (!interactive || remembered === null) return;
    restore.current = null;
    setPostsExpanded(remembered.postsExpanded);
    openAt(null, { instant: true, scrollTop: remembered.scrollTop });
  }, [interactive, openAt, channelId, mountKey]);

  // Open (or expanded): every rendered post row asked of the card cache in one
  // batch, so a tap opens its sheet at once.
  const postsShown = props.drawer.keys.includes('posts');
  const postIdsKey = postsShown
    ? renderedPostIds(props.drawer.posts.rows, postsExpanded).join(',')
    : '';
  useEffect(() => {
    prefetchPosts(cardCache, target === 'open', postIdsKey === '' ? [] : postIdsKey.split(','));
  }, [target, postIdsKey, cardCache]);

  // A tapped post not in the cache yet: its row is busy until the read lands
  // (open), fails or is hidden (toast), or the wait runs out (toast).
  const [busyPost, setBusyPost] = useState<string | null>(null);
  // The toast api is a fresh object each render: read it through a ref so the
  // wait timer below is not restarted by every re-render.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const failPost = useCallback((): void => {
    setBusyPost(null);
    toastRef.current.show({ title: POST_OPEN_FAILED });
  }, []);
  const cacheVersion = cardCache?.version() ?? 0;
  useEffect(() => {
    if (busyPost === null || cardCache === null) return;
    const settled = settleBusyPost(cardCache, busyPost);
    if (settled === null) return;
    if (settled === 'open') {
      setBusyPost(null);
      setPostSheet({ id: busyPost, open: true });
    } else failPost();
  }, [busyPost, cardCache, cacheVersion, failPost]);
  useEffect(() => {
    if (busyPost === null) return;
    const timer = setTimeout(failPost, POST_TAP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [busyPost, failPost]);
  const openPost = (postId: string): void => {
    if (busyPost !== null) return;
    const action = tapPost(cardCache, postId);
    if (action === 'open') setPostSheet({ id: postId, open: true });
    else if (action === 'busy') setBusyPost(postId);
    else failPost();
  };
  const remember = (): void => {
    if (channelId === undefined) return;
    rememberDrawer(channelId, props.locationKey, {
      scrollTop: listRef.current?.scrollTop ?? 0,
      postsExpanded,
    });
  };

  // Escape closes.
  useEffect(() => {
    if (target !== 'open') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]') !== null) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, close]);

  const onBarClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!interactive) return;
    const tap = barTap(target === 'open', e.target as Element);
    if (tap.action === 'close') close();
    else openAt(tap.section);
  };

  const down =
    (source: 'bar' | 'handle') =>
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!interactive) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      suppressClick.current = false;
      const height = panelHeight();
      const base = source === 'handle' || target === 'open' ? height : 0;
      gesture.current = {
        source,
        pointerId: e.pointerId,
        y0: e.clientY,
        base,
        moved: false,
        lastY: e.clientY,
        lastT: e.timeStamp,
        velocity: 0,
        offset: base,
      };
    };

  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || e.pointerId !== g.pointerId) return;
    const dy = e.clientY - g.y0;
    if (!g.moved) {
      if (Math.abs(dy) <= DRAG_SLOP) return;
      g.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic or already released pointer: the drag still follows moves here.
      }
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      if (!shown) {
        scrollTo.current = { section: null, scrollTop: null };
        measureTop();
        setShown(true);
      }
    }
    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.velocity = (e.clientY - g.lastY) / dt;
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;
    const height = panelHeight();
    const raw = g.base + dy;
    g.offset = Math.max(0, height > 0 ? Math.min(height, raw) : raw);
    setAnimate(false);
    setDrag(g.offset);
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || e.pointerId !== g.pointerId) return;
    gesture.current = null;
    if (!g.moved) {
      // A handle tap closes; a bar tap is the click's.
      if (g.source === 'handle') close();
      return;
    }
    suppressClick.current = true;
    const height = panelHeight();
    const fromOpen = g.base > 0;
    const stayOpen = fromOpen
      ? !snapShut({ offset: g.offset, height, velocity: g.velocity })
      : snapOpen({ offset: g.offset, height, velocity: g.velocity });
    if (stayOpen) {
      setAnimate(!reducedMotion());
      setDrag(null);
      setTarget('open');
      setEntered(true);
    } else close();
  };

  const cancel = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || e.pointerId !== g.pointerId) return;
    gesture.current = null;
    if (!g.moved) return;
    if (g.base > 0) {
      setAnimate(!reducedMotion());
      setDrag(null);
      setTarget('open');
      setEntered(true);
    } else close();
  };

  const height = panelHeight();
  const transform =
    drag !== null
      ? `translateY(calc(-100% + ${drag}px))`
      : entered
        ? 'translateY(0px)'
        : 'translateY(-100%)';
  const scrim = drag !== null ? (height > 0 ? Math.min(1, drag / height) : 0) : entered ? 1 : 0;
  const open = target === 'open' || drag !== null;

  return (
    <>
      <StatusTickerBar
        bar={bar}
        open={target === 'open'}
        barRef={(el) => {
          barEl.current = el;
        }}
        onBarClick={onBarClick}
        onPointerDown={down('bar')}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
      />
      {shown && interactive ? (
        <StatusDrawerPanel
          top={top}
          transform={transform}
          scrim={scrim}
          animate={animate}
          open={open}
          panelRef={panelRef}
          listRef={listRef}
          onScrim={() => close()}
          handle={{
            onPointerDown: down('handle'),
            onPointerMove: move,
            onPointerUp: up,
            onPointerCancel: cancel,
          }}
        >
          <StatusDrawerList
            {...props.drawer}
            {...props.actions}
            open={target === 'open'}
            postsExpanded={postsExpanded}
            onExpandPosts={() => setPostsExpanded(true)}
            busyPostId={busyPost}
            onOpenPost={openPost}
            onOpenBrief={(briefId) => {
              remember();
              props.navigate(props.briefRoute(briefId));
            }}
            onSeeAllBriefs={() => {
              remember();
              props.navigate('/briefs');
            }}
            onJumpMark={(messageId) => {
              close();
              props.actions.onJumpMark(messageId);
            }}
          />
        </StatusDrawerPanel>
      ) : null}
      <DrawerPostSheet
        cache={cardCache}
        postId={postSheet?.id ?? null}
        open={postSheet?.open === true}
        side={props.drawer.side}
        workspaceKey={props.drawer.workspaceKey}
        timeZone={props.drawer.timeZone}
        onClose={() => setPostSheet((prev) => (prev !== null ? { ...prev, open: false } : prev))}
      />
    </>
  );
}
