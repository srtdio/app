// React side of the motion module. Every hook here renders the FINAL state
// first and lays a move over it; nothing waits for data or for code to load.
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { LazyMotion, MotionGlobalConfig } from 'motion/react';
import { article as MArticle, div as MDiv, li as MLi, section as MSection } from 'motion/react-m';
import { cn } from '@/lib/cn';
import { installMotionPreference, motionOff } from './preference';
import type { Played } from './run';
import { settle, type Box } from './moves';
import { DUR_SLOW_MS, EASE, FLICK_PX_PER_MS } from './tokens';

// ---------- Root: LazyMotion, features at idle ----------

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const ric = (window as Window & { requestIdleCallback?: Window['requestIdleCallback'] })
      .requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: 4000 });
    else window.setTimeout(resolve, 1);
  });
}

/**
 * The domMax feature bundle (layout, layoutId, drag) loads after first paint at
 * idle. Until then every m.* element renders at its final state and layout
 * moves snap. Never awaited on a paint or tap path.
 */
export const loadMotionFeatures = (): Promise<typeof import('./features').default> =>
  idle()
    .then(() => import('./features'))
    .then((mod) => mod.default);

/** Wraps the app once (main.tsx). Also mirrors Reduce Motion / ?motion=0 into motion. */
export function MotionRoot({ children }: { children: ReactNode }) {
  useEffect(
    () =>
      installMotionPreference((off) => {
        MotionGlobalConfig.skipAnimations = off;
      }),
    [],
  );
  return createElement(LazyMotion, { features: loadMotionFeatures, strict: true }, children);
}

/** Reactive motion preference (Reduce Motion or ?motion=0). */
export function useMotionOff(): boolean {
  const [off, setOff] = useState(motionOff);
  useEffect(() => installMotionPreference(setOff), []);
  return off;
}

// ---------- Presence: keep mounted through an exit move ----------

export interface PresenceMoves<T extends Element> {
  /** Runs on the first frame after mount (layout effect, before paint). */
  enter?: (el: T) => Played | void;
  /** Runs on close; unmount waits for `done` (instant when motion is off). */
  exit?: (el: T) => Played;
}

/**
 * `rendered` stays true through the exit move; `ref` goes on the moving
 * element. Open renders at once at the final state; the enter move starts on
 * the first frame. A tap during either move finishes it (run.ts).
 */
export function usePresence<T extends HTMLElement>(
  open: boolean,
  moves: PresenceMoves<T>,
): { rendered: boolean; ref: RefObject<T>; leaving: boolean } {
  const ref = useRef<T>(null);
  const [rendered, setRendered] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const movesRef = useRef(moves);
  movesRef.current = moves;
  if (open && !rendered) setRendered(true);

  useLayoutEffect(() => {
    if (!open || !rendered) return;
    setLeaving(false);
    const el = ref.current;
    if (el !== null) movesRef.current.enter?.(el);
  }, [open, rendered]);

  useEffect(() => {
    if (open || !rendered) return;
    let live = true;
    setLeaving(true);
    const el = ref.current;
    const exit = movesRef.current.exit;
    const played = el !== null && exit !== undefined ? exit(el) : null;
    if (played === null || played.instant) {
      // Nothing to wait for: unmount in this commit (no microtask gap).
      setLeaving(false);
      setRendered(false);
      return;
    }
    void played.done.then(() => {
      if (!live) return;
      setLeaving(false);
      setRendered(false);
    });
    return () => {
      live = false;
    };
  }, [open, rendered]);

  return { rendered, ref, leaving };
}

/** Run a move once on mount, on the first frame (before paint). */
export function useMoveOnMount<T extends Element>(
  ref: RefObject<T>,
  run: (el: T) => Played | void,
  enabled = true,
): void {
  const runRef = useRef(run);
  runRef.current = run;
  useLayoutEffect(() => {
    if (!enabled || ref.current === null) return;
    runRef.current(ref.current);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Keys that arrived after the first render (itemIn only for those). The first
 * paint of a list, a kept view or a device-cache paint never animates.
 */
export function useFreshKeys(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (seen.current === null) {
    seen.current = new Set(keys);
    return fresh;
  }
  for (const key of keys) if (!seen.current.has(key)) fresh.add(key);
  for (const key of keys) seen.current.add(key);
  return fresh;
}

// ---------- 7. glide (FLIP via motion layout) ----------

const GLIDE_TRANSITION = { duration: 0.21, ease: [0.77, 0, 0.175, 1] as const };

type GlideTag = 'div' | 'li' | 'section' | 'article';

interface GlideItemProps extends HTMLAttributes<HTMLElement> {
  /** Lists and feeds glide on Y only (motion law); grids pass axis="xy". */
  axis?: 'y' | 'xy';
  as?: GlideTag;
  children?: ReactNode;
}

/**
 * A row or tile that glides to its new place when siblings enter or leave, a
 * list reorders or a grid reflows. Before the feature bundle loads it is a
 * plain element (snaps). Axis: Y (lists) or X+Y (grids).
 */
export function GlideItem({ axis = 'y', as = 'div', children, ...rest }: GlideItemProps) {
  const Tag = (
    { div: MDiv, li: MLi, section: MSection, article: MArticle } as const
  )[as] as unknown as (props: Record<string, unknown>) => ReactNode;
  return createElement(
    Tag,
    {
      ...rest,
      layout: axis === 'y' ? 'position' : true,
      transition: GLIDE_TRANSITION,
      'data-move': 'glide',
      'data-axis': axis,
    },
    children,
  );
}

// ---------- 2. growFromCard: remember the tapped card ----------

let tappedCard: { key: string; box: Box; at: number } | null = null;
let leftPage: { key: string; box: Box; at: number } | null = null;
const CARD_MEMORY_MS = 4000;

/** Call from a card's tap handler before navigating. */
export function rememberCard(key: string, el: Element | null): void {
  if (el === null) return;
  const r = el.getBoundingClientRect();
  tappedCard = { key, box: { left: r.left, top: r.top, width: r.width, height: r.height }, at: Date.now() };
}

/** The remembered card for this page, once (consumed). Null when stale or absent. */
export function takeCard(key?: string): Box | null {
  const card = tappedCard;
  tappedCard = null;
  if (card === null || Date.now() - card.at > CARD_MEMORY_MS) return null;
  if (key !== undefined && card.key !== key) return null;
  return card.box;
}

/** Call when a grown page closes, so the list can grow back into the card. */
export function rememberPage(key: string, el: Element | null): void {
  if (el === null) return;
  const r = el.getBoundingClientRect();
  leftPage = { key, box: { left: r.left, top: r.top, width: r.width, height: r.height }, at: Date.now() };
}

/** The page rect to grow back from, for the card with this key (consumed). */
export function takePage(key: string): Box | null {
  const page = leftPage;
  if (page === null || page.key !== key) return null;
  leftPage = null;
  return Date.now() - page.at > CARD_MEMORY_MS ? null : page.box;
}

// ---------- 1. push: iPhone swipe-back skip ----------

let uaTransition = false;
let uaListening = false;

/** Install once: remembers whether the last popstate already had Safari's own swipe animation. */
export function watchUAVisualTransition(): void {
  if (uaListening || typeof window === 'undefined') return;
  uaListening = true;
  window.addEventListener(
    'popstate',
    (event) => {
      uaTransition = (event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
      // Only the navigation it belongs to may read it.
      window.setTimeout(() => {
        uaTransition = false;
      }, 500);
    },
    { capture: true },
  );
}

/** True when the browser already animated this back (iPhone swipe): skip our push. */
export function skipForUATransition(event?: Event): boolean {
  if (event !== undefined) {
    return (event as Event & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
  }
  return uaTransition;
}

// ---------- Drag to dismiss (sheet Y, edge back X, toast Y) ----------

export interface DragDismissOptions {
  axis: 'x' | 'y';
  /** +1: dismiss by dragging right/down. -1: up/left. */
  direction: 1 | -1;
  /** Closes past this distance... */
  closeAt: number;
  /** ...or on a flick over 0.5 px/ms in the dismiss direction. */
  flick?: number;
  /** Only start when the pointer goes down within this many px of the start edge (edge back). */
  edgeZone?: number;
  /** Follow the finger: called with the current offset (0 at rest). */
  onMove: (offset: number) => void;
  /** Released past the threshold: close from `offset`. */
  onDismiss: (offset: number) => void;
  /** Released short: spring back from `offset`. */
  onCancel: (offset: number) => void;
  enabled?: boolean;
}

/** Pointer handlers for a drag that follows the finger on one axis. */
export function useDragDismiss(options: DragDismissOptions) {
  const state = useRef<{ start: number; cross: number; t: number; last: number; lastT: number; id: number; locked: boolean } | null>(null);
  const opts = useRef(options);
  opts.current = options;

  function along(event: ReactPointerEvent): number {
    return opts.current.axis === 'x' ? event.clientX : event.clientY;
  }
  function across(event: ReactPointerEvent): number {
    return opts.current.axis === 'x' ? event.clientY : event.clientX;
  }

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void {
      const o = opts.current;
      if (o.enabled === false || event.button !== 0) return;
      if (o.edgeZone !== undefined && along(event) > o.edgeZone) return;
      const now = event.timeStamp;
      state.current = { start: along(event), cross: across(event), t: now, last: along(event), lastT: now, id: event.pointerId, locked: false };
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>): void {
      const s = state.current;
      if (s === null || s.id !== event.pointerId) return;
      const o = opts.current;
      const delta = (along(event) - s.start) * o.direction;
      if (!s.locked) {
        const off = Math.abs(across(event) - s.cross);
        if (off > 10 && off > Math.abs(delta)) {
          state.current = null; // A cross-axis gesture (scroll): let it go.
          return;
        }
        if (delta < 6) return;
        s.locked = true;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
      s.last = along(event);
      s.lastT = event.timeStamp;
      o.onMove(Math.max(0, delta) * o.direction);
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>): void {
      const s = state.current;
      state.current = null;
      if (s === null || !s.locked) return;
      const o = opts.current;
      const delta = Math.max(0, (along(event) - s.start) * o.direction);
      const dt = Math.max(1, event.timeStamp - s.t);
      const velocity = delta / dt;
      const flick = o.flick ?? FLICK_PX_PER_MS;
      if (delta >= o.closeAt || velocity > flick) o.onDismiss(delta * o.direction);
      else o.onCancel(delta * o.direction);
    },
    onPointerCancel(): void {
      const s = state.current;
      state.current = null;
      if (s !== null && s.locked) opts.current.onCancel(0);
    },
  };
}

/**
 * Backdrop dim tracks the sheet's position (decision 2): darker as it rises,
 * lighter as it is dragged down. Never a timed fade of its own. Returns a stop.
 */
export function trackDim(panel: HTMLElement | null, dim: HTMLElement | null, played?: Played): () => void {
  if (panel === null || dim === null) return () => undefined;
  let frame = 0;
  let stopped = false;
  const rest = (): number => {
    // Read the resting top from layout (transform excluded).
    return panel.offsetTop;
  };
  const restTop = rest();
  const height = panel.offsetHeight || 1;
  const tick = (): void => {
    if (stopped) return;
    const top = panel.getBoundingClientRect().top - (panel.offsetParent?.getBoundingClientRect().top ?? 0);
    const progress = 1 - Math.min(1, Math.max(0, (top - restTop) / height));
    dim.style.opacity = String(progress);
    frame = requestAnimationFrame(tick);
  };
  tick();
  const stop = (): void => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
  void played?.done.then(() => {
    stop();
    dim.style.opacity = '';
  });
  return stop;
}

/** Set the dim from a drag offset directly (offset px of panel height). */
export function dimFor(offset: number, height: number): string {
  return String(1 - Math.min(1, Math.max(0, offset / Math.max(1, height))));
}

// ---------- 9. sweepBoxes: Bone and BoxSkeleton ----------

interface BoneProps {
  className?: string;
  style?: CSSProperties;
  /** Render as a block-level <div> (default <span class="block">). */
  as?: 'span' | 'div';
}

/**
 * One loading box. Size and radius come from the caller so it matches the
 * final layout exactly (no shift on landing). A top-lit sweep runs over it,
 * 1100 ms linear, looping; it never fades or pulses.
 */
export function Bone({ className, style, as = 'span' }: BoneProps) {
  return createElement(as, {
    'aria-hidden': true,
    'data-bone': '',
    className: cn('block mv-bone', className),
    style,
  });
}

interface BoxSkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Screen-reader label, e.g. "Loading activity". */
  label?: string;
  children: ReactNode;
}

/**
 * Wraps a screen's boxes. Render it ONLY when the device or session holds
 * nothing for that screen; kept views and the device cache paint at once.
 */
export function BoxSkeleton({ label = 'Loading', className, children, ...rest }: BoxSkeletonProps) {
  return createElement(
    'div',
    { ...rest, role: 'status', 'aria-busy': true, 'aria-label': label, 'data-box-skeleton': '', className },
    children,
  );
}

/**
 * Real content landing after boxes: each of the first 5 children settles 6 px,
 * 200 ms, 40 ms stagger. Runs once, only when boxes were showing before.
 */
export function useSettleOnLanding(ref: RefObject<HTMLElement>, landed: boolean, hadBoxes: boolean): void {
  const done = useRef(false);
  useLayoutEffect(() => {
    if (done.current || !landed || !hadBoxes || ref.current === null) return;
    done.current = true;
    settle(ref.current.children);
  }, [landed, hadBoxes, ref]);
}

/** True once boxes have rendered in this mount (for useSettleOnLanding). */
export function useHadBoxes(showingBoxes: boolean): boolean {
  const had = useRef(false);
  if (showingBoxes) had.current = true;
  return had.current;
}

/** Shared CSS move classes (motion.css). Call sites use these, never their own transitions. */
export const MOVE_CLASS = {
  /** 5. press: scale .97 while held, 120 ms (plus colour ease). */
  press: 'mv-press',
  /** Hover/state colour ease, no movement. */
  tint: 'mv-tint',
  /** Knob, thumb, chevron: transform ease 160 ms (axis declared by the caller's transform). */
  slide: 'mv-slide',
  /** Rotation (plus to X 45deg, chevron 180deg), 200 ms. */
  turn: 'mv-turn',
  /** Progress fill tracking real progress. */
  fill: 'mv-fill',
  /** Upload ring finish: scale to 0. */
  ringOut: 'mv-ring-out',
  /** Board drag: lifted card at 1.02 (with one lit height up). */
  lift: 'mv-lift',
  /** Busy spinner rotation. */
  spin: 'mv-spin',
} as const;

/** Exit/enter durations exposed for unmount timers that must match a move. */
export const PRESENCE_FALLBACK_MS = DUR_SLOW_MS;
export const GLIDE_EASE = EASE.move;
