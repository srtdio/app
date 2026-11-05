// The one player. Every JS move in the app goes through play(): it checks the
// motion preference, refuses opacity, declares an axis, registers the running
// animation so any tap or key press finishes it, and drops paintlog marks.
//
// Pattern: the element is ALWAYS rendered at its final state by React/CSS.
// play() lays a Web Animation over it that runs from a start pose to that final
// pose (fill: none), so when the animation ends, is finished early, or never
// runs (motion off, no Web Animations), the element shows its final state.
// Exits pass fill: 'forwards' and unmount on `done`.
import { mark } from '@/lib/perf-marks';
import { motionOff } from './preference';

/** Every move declares the axis it moves on (motion law). Lists and feeds are 'y' only. */
export type Axis = 'x' | 'y' | 'scale' | 'rotate' | 'clip' | 'fill' | 'tint' | 'none';

export type MoveName =
  | 'push'
  | 'growFromCard'
  | 'rise'
  | 'growFromTrigger'
  | 'press'
  | 'itemIn'
  | 'itemOut'
  | 'glide'
  | 'edgeStrip'
  | 'sweepBoxes'
  | 'touch';

export interface MoveSpec {
  move: MoveName;
  /** What this move animates; play() refuses keyframes outside it. */
  axis: readonly Axis[];
  /** push, growFromCard and rise drop motion:start / motion:end paintlog marks. */
  marked?: boolean;
}

export interface PlayOptions {
  duration: number;
  easing: string;
  delay?: number;
  /** 'forwards' for exits that unmount on done. */
  fill?: FillMode;
  /** CSS transform-origin for the move (scale-from-origin moves). */
  origin?: string;
}

export interface Played {
  /** Resolves when the move ends, is finished early, or never ran. Never rejects. */
  done: Promise<void>;
  /** Jump to the end state now. */
  finish: () => void;
  /** True when nothing ran (motion off, no element, no Web Animations): callers may unmount now. */
  instant: boolean;
  /** Drop the move and its held end pose (for holds a later move replaces). */
  cancel: () => void;
}

const DONE: Played = {
  done: Promise.resolve(),
  finish: () => undefined,
  instant: true,
  cancel: () => undefined,
};
const running = new Set<Animation>();
let listening = false;

/** Finish every running move (end state). Called on any tap or key press. */
export function finishAll(): void {
  for (const animation of [...running]) {
    try {
      animation.finish();
    } catch {
      // A zero-length or detached animation: drop it.
      running.delete(animation);
    }
  }
}

function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // Capture phase, so the tap's own handler starts its move after the old ones end.
  document.addEventListener('pointerdown', finishAll, { capture: true, passive: true });
  document.addEventListener('keydown', finishAll, { capture: true });
}

/** Number of moves in flight (tests and the paintlog). */
export function runningCount(): number {
  return running.size;
}

const AXIS_PROPS: Record<Axis, readonly string[]> = {
  x: ['transform', 'translate'],
  y: ['transform', 'translate'],
  scale: ['transform', 'scale', 'borderRadius', 'transformOrigin'],
  rotate: ['transform', 'rotate'],
  clip: ['clipPath', 'height'],
  fill: ['strokeDashoffset', 'backgroundPosition', 'width'],
  // Colour only (ink and fill colour): never opacity, never the light.
  tint: ['color', 'backgroundColor'],
  none: [],
};

/** Throws on opacity or a property outside the declared axis (motion law). */
export function checkKeyframes(spec: MoveSpec, keyframes: Keyframe[]): void {
  const allowed = new Set(spec.axis.flatMap((axis) => AXIS_PROPS[axis]));
  allowed.add('offset');
  allowed.add('easing');
  allowed.add('composite');
  for (const frame of keyframes) {
    for (const key of Object.keys(frame)) {
      if (key === 'opacity') throw new Error(`motion: ${spec.move} animates opacity (never fade)`);
      if (!allowed.has(key)) {
        throw new Error(
          `motion: ${spec.move} animates ${key} outside its axis ${spec.axis.join('+')}`,
        );
      }
    }
  }
}

/**
 * Run one move on an element that already shows its final state. Instant
 * (returns a resolved Played) when motion is off, the element is missing or
 * Web Animations are unavailable (jsdom).
 */
export function play(
  el: Element | null | undefined,
  spec: MoveSpec,
  keyframes: Keyframe[],
  options: PlayOptions,
): Played {
  checkKeyframes(spec, keyframes);
  if (el === null || el === undefined || motionOff()) return DONE;
  if (typeof (el as HTMLElement).animate !== 'function') return DONE;
  listen();
  if (spec.marked === true) mark(`motion:start:${spec.move}`);
  let animation: Animation;
  try {
    const frames = options.origin
      ? keyframes.map((frame) => ({ ...frame, transformOrigin: options.origin }))
      : keyframes;
    animation = (el as HTMLElement).animate(frames, {
      duration: options.duration,
      easing: options.easing,
      delay: options.delay ?? 0,
      fill: options.fill ?? 'none',
    });
  } catch {
    return DONE;
  }
  running.add(animation);
  const done = new Promise<void>((resolve) => {
    const end = (): void => {
      running.delete(animation);
      if (spec.marked === true) mark(`motion:end:${spec.move}`);
      resolve();
    };
    animation.addEventListener('finish', end, { once: true });
    animation.addEventListener('cancel', end, { once: true });
  });
  return {
    done,
    instant: false,
    cancel: () => {
      try {
        animation.cancel();
      } catch {
        running.delete(animation);
      }
    },
    finish: () => {
      try {
        animation.finish();
      } catch {
        running.delete(animation);
      }
    },
  };
}

/** Test seam: forget listeners and running moves. */
export function resetPlayerForTests(): void {
  running.clear();
  if (listening && typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', finishAll, { capture: true });
    document.removeEventListener('keydown', finishAll, { capture: true });
  }
  listening = false;
}
