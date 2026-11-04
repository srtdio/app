/**
 * One countdown that can stop and pick up again with the time it had left.
 * The Undo strip and every toast run their lifetime (UNDO_MS, TOAST_MS) on it,
 * so a person reading, focusing or touching one never loses it mid-read.
 *
 * Holds are named (hover, focus, press): the clock runs only while no hold is
 * on, so a release of one reason never restarts a countdown another reason
 * still holds. Framework-free and fake-timer friendly (setTimeout + Date.now).
 */

import { LAPTOP_MIN_WIDTH_PX } from '@/lib/use-is-laptop';

/** Why a countdown is held. */
export type HoldReason = 'hover' | 'focus' | 'press';

export interface PausableTimer {
  /** Stop the clock for `reason`. No-op once fired or cancelled. */
  hold: (reason: HoldReason) => void;
  /** Lift `reason`; the clock resumes with the time left once no hold remains. */
  release: (reason: HoldReason) => void;
  /** Stop for good; `onDone` never runs. */
  cancel: () => void;
  /** Milliseconds left on the clock (frozen while held). */
  remaining: () => number;
  /** True while at least one hold is on. */
  held: () => boolean;
}

/** Run `onDone` after `ms` of unheld time. `ms` <= 0 runs on the next tick. */
export function createPausableTimer(onDone: () => void, ms: number): PausableTimer {
  let left = Math.max(0, ms);
  let startedAt = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const holds = new Set<HoldReason>();

  function start(): void {
    startedAt = Date.now();
    handle = setTimeout(() => {
      handle = null;
      done = true;
      onDone();
    }, left);
  }

  function stop(): void {
    if (handle === null) return;
    clearTimeout(handle);
    handle = null;
    left = Math.max(0, left - (Date.now() - startedAt));
  }

  start();

  return {
    hold(reason) {
      if (done) return;
      holds.add(reason);
      stop();
    },
    release(reason) {
      if (done || !holds.delete(reason) || holds.size > 0) return;
      start();
    },
    cancel() {
      done = true;
      holds.clear();
      if (handle !== null) clearTimeout(handle);
      handle = null;
    },
    remaining() {
      if (done) return 0;
      return handle === null ? left : Math.max(0, left - (Date.now() - startedAt));
    },
    held: () => holds.size > 0,
  };
}

/** The minimal event shapes holdHandlers reads (React's synthetic events fit). */
interface HoldPointerEvent {
  pointerType: string;
}
interface HoldFocusEvent {
  currentTarget: { contains: (node: Node | null) => boolean };
  relatedTarget: EventTarget | null;
}

// Hover holds only on a laptop with a mouse (the same media as useIsLaptop and
// useHoverPointer). A phone's synthesized mouse events would otherwise hold a
// toast with no pointerleave ever coming, so it would never go. Without
// matchMedia (unit tests), assume a laptop.
const HOVER_LAPTOP = `(hover: hover) and (pointer: fine) and (min-width: ${LAPTOP_MIN_WIDTH_PX}px)`;
function canHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(HOVER_LAPTOP).matches;
}

/**
 * Event props that hold a countdown while a surface is hovered (mouse),
 * focused (focus anywhere inside), or touched (pointerdown until the pointer
 * is released or cancelled anywhere, so a finger that slides off never leaves
 * it held). Spread or compose them on the surface's root element.
 */
// A press is under way on some hold surface (pointerdown until pointerup or
// cancel). Module-level so a re-render between pointerdown and focus, which
// makes new handlers, still sees it.
let pressing = false;

export function holdHandlers(onHold: (reason: HoldReason, held: boolean) => void): {
  onPointerEnter: (event: HoldPointerEvent) => void;
  onPointerLeave: (event: HoldPointerEvent) => void;
  onPointerDown: () => void;
  onFocus: () => void;
  onBlur: (event: HoldFocusEvent) => void;
} {
  return {
    onPointerEnter(event) {
      if (event.pointerType === 'mouse' && canHover()) onHold('hover', true);
    },
    onPointerLeave(event) {
      if (event.pointerType === 'mouse') onHold('hover', false);
    },
    onPointerDown() {
      pressing = true;
      onHold('press', true);
      if (typeof window === 'undefined') return;
      const end = (): void => {
        pressing = false;
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
        onHold('press', false);
      };
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    },
    onFocus() {
      // Focus that comes with a press (a tap or click on the card, which is a
      // button) is not a hold: nothing would ever blur it, so the card would
      // never go. The press itself holds until it is released.
      if (pressing) return;
      onHold('focus', true);
    },
    onBlur(event) {
      const next = event.relatedTarget;
      const inside =
        typeof Node !== 'undefined' && next instanceof Node && event.currentTarget.contains(next);
      if (!inside) onHold('focus', false);
    },
  };
}
