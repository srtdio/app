/** Movement (px) that decides the direction: right captures, anything else releases. */
export const SWIPE_LOCK_PX = 8;
/** Offset (px) at which a release replies; the bubble follows 1:1 up to here. */
export const SWIPE_TRIGGER_PX = 64;
/** Share of the finger's travel the bubble follows beyond SWIPE_TRIGGER_PX. */
const SWIPE_RESISTANCE = 0.3;
/** The bubble never travels further than this (px). */
export const SWIPE_MAX_PX = 120;
/** A rightward flick at least this fast (px/ms) replies below the trigger... */
export const SWIPE_FLICK_VELOCITY = 0.5;
/** ...once the finger has travelled at least this far (px). */
export const SWIPE_FLICK_MIN_PX = 24;
/** Velocity is measured over the samples of the last this-many ms. */
const SWIPE_VELOCITY_WINDOW_MS = 100;
/** A press this close (px) to the left screen edge belongs to the iOS back gesture. */
export const SWIPE_EDGE_PX = 20;
/** Spring-back duration (ms) after a release or cancel. */
export const SWIPE_SPRING_MS = 180;
/** Haptic tick (ms) when the gesture crosses the trigger. */
export const SWIPE_VIBRATE_MS = 10;

/** The only pointer fields the controller reads; React's PointerEvent satisfies it. */
interface SwipePointerSample {
  clientX: number;
  clientY: number;
  /** 'mouse' | 'touch' | 'pen'; absent reads as touch. */
  pointerType?: string;
  pointerId?: number;
  /** Event time (ms); absent reads the controller's clock. */
  timeStamp?: number;
  /**
   * The pressed element (React's currentTarget, else the target), read on the
   * press only: a scroll cancels the swipe only when its scroller holds it.
   * Absent: any scroll cancels.
   */
  currentTarget?: EventTarget | null;
  target?: EventTarget | null;
}

/** An Element or the Document: something a scroll event can come from that may hold the press. */
interface ScrollSource {
  contains: (other: Node | null) => boolean;
}

/** The event target as a ScrollSource (duck-typed: no DOM globals needed). */
function scrollSource(target: unknown): ScrollSource | null {
  if (target === null || typeof target !== 'object') return null;
  return typeof (target as { contains?: unknown }).contains === 'function'
    ? (target as ScrollSource)
    : null;
}

/** What the view paints: the bubble's translateX and the reply icon's state. */
export interface SwipeFrame {
  /** Bubble translateX in px (0 at rest). */
  offset: number;
  /** At or past the trigger: the icon fills with the accent. */
  armed: boolean;
  /** 0..1 toward the trigger; drives the icon's scale and opacity (0 to 1). */
  progress: number;
  /** Spring back with a transition; false while dragging or under reduced motion. */
  animate: boolean;
  /** The finger owns the bubble: will-change: transform is set only then. */
  dragging: boolean;
  /** Which way the row is sliding: 'right' (reply) or 'left' (delete). */
  side: SwipeSide;
}

/** A swipe's way: right = Reply, left = Delete (CLAUDE.md Swipe rule). */
export type SwipeSide = 'right' | 'left';

export const SWIPE_REST: SwipeFrame = {
  offset: 0,
  armed: false,
  progress: 0,
  animate: false,
  dragging: false,
  side: 'right',
};

export interface SwipeReplyHandlers {
  onPointerDown: (event: SwipePointerSample) => void;
  onPointerMove: (event: SwipePointerSample) => void;
  /** The release; its timeStamp (absent: the controller's clock) ends the velocity window. */
  onPointerUp: (event?: Pick<SwipePointerSample, 'timeStamp'>) => void;
  onPointerCancel: () => void;
}

export interface SwipeReplyController {
  handlers: SwipeReplyHandlers;
  /**
   * Call at the start of a trailing click handler. Returns true (once) when the
   * click is the tail of a swipe and should be ignored.
   */
  consumeClickSuppression: () => boolean;
  /** True while a swipe (either way) owns the pointer. */
  swiping: () => boolean;
  /** Abort without replying (a long-press fired, the list scrolled). */
  cancel: () => void;
  /** Clear state and listeners. */
  dispose: () => void;
}

export interface SwipeReplyOptions {
  /** A rightward swipe released past the trigger or flicked. At most once per gesture. */
  onReply?: () => void;
  /** A leftward swipe released past the trigger or flicked (Delete). At most once per gesture. */
  onLeft?: () => void;
  /** Paint a frame (bubble offset, icon state). Drag frames arrive once per animation frame. */
  onFrame: (frame: SwipeFrame) => void;
  /**
   * The swipe locked in: capture the pointer, cancel every long-press timer
   * (the bubble's and any inside it) and the text selection.
   */
  onStart?: (pointerId: number | undefined) => void;
  /** False turns the gesture off (selection mode, a sending or failed bubble). */
  enabled?: () => boolean;
  /** prefers-reduced-motion: no spring, instant reset. */
  reducedMotion?: () => boolean;
  vibrate?: (ms: number) => void;
  /** Schedules a drag frame; defaults to requestAnimationFrame. */
  raf?: (paint: () => void) => number;
  cancelRaf?: (handle: number) => void;
  /** Clock for samples without a timeStamp (ms). */
  now?: () => number;
  /**
   * Which way the gesture goes; default right (reply). 'left' mirrors it (a
   * task row's swipe to delete), 'both' takes either way, decided when the
   * swipe locks in. The frame's offset is the magnitude and its side the way.
   * A rightward swipe never starts within SWIPE_EDGE_PX of the left screen
   * edge, a leftward one never within SWIPE_EDGE_PX of the right edge: those
   * are the system's (back / forward).
   */
  direction?: SwipeSide | 'both';
  /**
   * Per gesture, whether a way may trigger: false still lets the row
   * rubber-band (a marked message, a tombstone) but nothing fires. Default true.
   */
  canTrigger?: (side: SwipeSide) => boolean;
}

/** A rubber band: the row follows a little and never arms (canTrigger false). */
export function swipeRubberBand(dx: number): number {
  if (dx <= 0) return 0;
  return Math.min(SWIPE_TRIGGER_PX / 2, dx * SWIPE_RESISTANCE);
}

/** The bubble offset for a finger travel: 1:1 to the trigger, 0.3 beyond, capped, never left. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_TRIGGER_PX) return dx;
  return Math.min(SWIPE_MAX_PX, SWIPE_TRIGGER_PX + (dx - SWIPE_TRIGGER_PX) * SWIPE_RESISTANCE);
}

/** Whether a release replies: past the trigger, or a fast enough rightward flick. */
export function swipeTriggers(dx: number, velocity: number): boolean {
  if (swipeOffset(dx) >= SWIPE_TRIGGER_PX) return true;
  return dx >= SWIPE_FLICK_MIN_PX && velocity >= SWIPE_FLICK_VELOCITY;
}

/** navigator.vibrate where it exists (not iPhone); no polyfill. */
export function defaultVibrate(ms: number): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(ms);
  }
}

function defaultRaf(paint: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(paint);
  paint();
  return 0;
}

function defaultCancelRaf(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Framework-free swipe core, the sibling of createLongPressController: swipe
 * to reply (rightward, the default) and, mirrored, a task row's swipe to
 * delete (direction 'left'). Touch and pen only. A press is pending until it
 * moves SWIPE_LOCK_PX: the gesture's way (and more horizontal than vertical)
 * locks the swipe in, anything else releases it for the list to scroll. A tap
 * that never moves that far is not a swipe. A press within SWIPE_EDGE_PX of
 * the screen edge the system's own gesture owns is left to it.
 */
export function createSwipeReplyController({
  onReply,
  onLeft,
  canTrigger = () => true,
  onFrame,
  onStart,
  enabled = () => true,
  reducedMotion = () => false,
  vibrate = defaultVibrate,
  raf = defaultRaf,
  cancelRaf = defaultCancelRaf,
  now = defaultNow,
  direction = 'right',
}: SwipeReplyOptions): SwipeReplyController {
  let sign = direction === 'left' ? -1 : 1;
  let side: SwipeSide = direction === 'left' ? 'left' : 'right';
  let allowed = true;
  let phase: 'idle' | 'pending' | 'swiping' = 'idle';
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let pointerId: number | undefined;
  /** The pressed element (see SwipePointerSample.currentTarget); null: unknown. */
  let pressed: Node | null = null;
  let buzzed = false;
  let suppressClick = false;
  /** Recent (x, t) samples for the release velocity. */
  let samples: Array<{ x: number; t: number }> = [];
  let pending: SwipeFrame | null = null;
  let rafHandle: number | null = null;

  /**
   * A scroll the press moves with (the window, or a scroller around the
   * pressed row) ends the swipe: the list scrolled. Any other scroller is not
   * the press's business: the chat thread behind the Tasks sheet pinning to a
   * new line (an autosave landing) must not end a task row's swipe. With no
   * pressed element known, every scroll cancels.
   */
  function onScroll(event?: Event): void {
    const from = scrollSource(event?.target);
    if (pressed !== null && from !== null && !from.contains(pressed)) return;
    cancel();
  }

  function attachScroll(): void {
    if (typeof window !== 'undefined') window.addEventListener('scroll', onScroll, true);
  }

  function detachScroll(): void {
    if (typeof window !== 'undefined') window.removeEventListener('scroll', onScroll, true);
  }

  function dropFrame(): void {
    if (rafHandle !== null) cancelRaf(rafHandle);
    rafHandle = null;
    pending = null;
  }

  /** Queue a drag frame: at most one paint per animation frame, the latest wins. */
  function queue(frame: SwipeFrame): void {
    pending = frame;
    if (rafHandle !== null) return;
    let painted = false;
    const handle = raf(() => {
      painted = true;
      rafHandle = null;
      const next = pending;
      pending = null;
      if (next !== null) onFrame(next);
    });
    // A synchronous scheduler (no requestAnimationFrame) has already painted.
    if (!painted) rafHandle = handle;
  }

  /** Back to idle; springs the bubble home when it had moved. */
  function reset(): void {
    const moved = phase === 'swiping';
    phase = 'idle';
    buzzed = false;
    dx = 0;
    samples = [];
    pointerId = undefined;
    pressed = null;
    detachScroll();
    dropFrame();
    if (moved) onFrame({ ...SWIPE_REST, side, animate: !reducedMotion() });
    allowed = true;
    if (direction === 'both') {
      sign = 1;
      side = 'right';
    }
  }

  function cancel(): void {
    reset();
  }

  /** The screen edge the system's own gesture owns for a swipe that way. */
  function nearSystemEdge(clientX: number, way: SwipeSide): boolean {
    if (way === 'right') return clientX < SWIPE_EDGE_PX;
    const width = typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY;
    return clientX > width - SWIPE_EDGE_PX;
  }

  function samePointer(event: SwipePointerSample): boolean {
    return (
      pointerId === undefined || event.pointerId === undefined || event.pointerId === pointerId
    );
  }

  /**
   * The release velocity (px/ms): only the samples of the last
   * SWIPE_VELOCITY_WINDOW_MS before the release count, and a finger that
   * stopped moving longer ago than that is not flicking (0).
   */
  function velocity(releaseT: number): number {
    const recent = samples.filter((sample) => releaseT - sample.t <= SWIPE_VELOCITY_WINDOW_MS);
    const last = recent[recent.length - 1];
    const first = recent[0];
    if (last === undefined || first === undefined || last.t <= first.t) return 0;
    return (sign * (last.x - first.x)) / (last.t - first.t);
  }

  function onPointerDown(event: SwipePointerSample): void {
    reset();
    suppressClick = false;
    if ((event.pointerType ?? '') === 'mouse' || !enabled()) return;
    if (direction !== 'both' && nearSystemEdge(event.clientX, direction)) return;
    phase = 'pending';
    startX = event.clientX;
    startY = event.clientY;
    pointerId = event.pointerId;
    // Only an element (anything with contains) counts as the press's node.
    const node = event.currentTarget ?? event.target ?? null;
    pressed = scrollSource(node) !== null ? (node as Node) : null;
    samples = [{ x: event.clientX, t: event.timeStamp ?? now() }];
    attachScroll();
  }

  function onPointerMove(event: SwipePointerSample): void {
    if (phase === 'idle' || !samePointer(event)) return;
    const t = event.timeStamp ?? now();
    samples.push({ x: event.clientX, t });
    while (samples.length > 2 && t - (samples[0]?.t ?? t) > SWIPE_VELOCITY_WINDOW_MS) {
      samples.shift();
    }
    const rawDx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (phase === 'pending') {
      if (rawDx * rawDx + dy * dy < SWIPE_LOCK_PX * SWIPE_LOCK_PX) return;
      if (direction === 'both') {
        sign = rawDx >= 0 ? 1 : -1;
        side = rawDx >= 0 ? 'right' : 'left';
      }
      const lockDx = sign * rawDx;
      if (
        lockDx <= 0 ||
        Math.abs(dy) >= lockDx ||
        (direction === 'both' && nearSystemEdge(startX, side))
      ) {
        // Vertical, the other way or the system's edge: not ours. The list
        // scrolls, long-press as before.
        reset();
        return;
      }
      allowed = canTrigger(side);
      phase = 'swiping';
      suppressClick = true;
      onStart?.(pointerId);
    }
    dx = sign * rawDx;
    const offset = allowed ? swipeOffset(dx) : swipeRubberBand(dx);
    const armed = allowed && offset >= SWIPE_TRIGGER_PX;
    if (armed && !buzzed) {
      buzzed = true;
      vibrate(SWIPE_VIBRATE_MS);
    }
    queue({
      offset,
      armed,
      progress: Math.min(1, offset / SWIPE_TRIGGER_PX),
      animate: false,
      dragging: true,
      side,
    });
  }

  function onPointerUp(event?: Pick<SwipePointerSample, 'timeStamp'>): void {
    const releaseT = event?.timeStamp ?? now();
    const fire = phase === 'swiping' && allowed && swipeTriggers(dx, velocity(releaseT));
    const way = side;
    reset();
    if (!fire) return;
    if (way === 'right') onReply?.();
    // A one-way 'left' controller may still name its action onReply (TaskRow, before).
    else (onLeft ?? (direction === 'left' ? onReply : undefined))?.();
  }

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancel },
    consumeClickSuppression(): boolean {
      const value = suppressClick;
      suppressClick = false;
      return value;
    },
    swiping: () => phase === 'swiping',
    cancel,
    dispose(): void {
      reset();
      suppressClick = false;
    },
  };
}
