// Small touches for the guided tour's hand (docs/motion.md, small touches).
// They replace the tour's old CSS keyframes (an infinite press loop and a
// ripple that faded): every one is finite, runs through play() (so Reduce
// Motion and ?motion=0 make it instant and any tap or key press finishes it),
// declares its axis and never touches opacity. The elements always render at
// their rest pose; these are laid over it.
import { play, type MoveSpec, type Played } from './run';
import { DUR_SLOW_MS, EASE } from './tokens';

/** The hand presses: scale with a small travel toward the control. Axis: scale. */
export const TOUCH_HAND_PRESS: MoveSpec = { move: 'touch', axis: ['scale'] };
/** The guide's nudge after a tap away: a short X wiggle. Axis: x. */
export const TOUCH_NUDGE: MoveSpec = { move: 'touch', axis: ['x'] };

/** One press cycle: 6.5 slow beats (1300 ms), as before. */
export const GUIDE_PRESS_MS = DUR_SLOW_MS * 6.5;
/** The nudge: 1.5 slow beats (300 ms). */
export const GUIDE_NUDGE_MS = DUR_SLOW_MS * 1.5;
/** The ripple's rest scale (the ring at rest is drawn at this scale by the caller). */
export const GUIDE_RIPPLE_REST_SCALE = 0.8;

/** The hand presses the control twice, then rests. Origin at the fingertip. */
export function handPress(el: Element | null, origin = '17px 1px'): Played {
  return play(
    el,
    TOUCH_HAND_PRESS,
    [
      { transform: 'translate(0, 0) scale(1)', offset: 0 },
      { transform: 'translate(1px, 2px) scale(0.9)', offset: 0.1 },
      { transform: 'translate(0, 0) scale(1)', offset: 0.2 },
      { transform: 'translate(1px, 2px) scale(0.9)', offset: 0.3 },
      { transform: 'translate(0, 0) scale(1)', offset: 0.4 },
      { transform: 'translate(0, 0) scale(1)', offset: 1 },
    ],
    { duration: GUIDE_PRESS_MS, easing: EASE.enter, origin },
  );
}

/**
 * The ring at the fingertip grows out with the presses and settles back to its
 * rest scale. Scale only: it never fades (the old ripple faded in and out).
 */
export function handRipple(el: Element | null): Played {
  const rest = `scale(${GUIDE_RIPPLE_REST_SCALE})`;
  return play(
    el,
    TOUCH_HAND_PRESS,
    [
      { transform: 'scale(0.4)', offset: 0 },
      { transform: 'scale(1.2)', offset: 0.2 },
      { transform: 'scale(0.4)', offset: 0.21 },
      { transform: 'scale(1.2)', offset: 0.4 },
      { transform: rest, offset: 0.6 },
      { transform: rest, offset: 1 },
    ],
    { duration: GUIDE_PRESS_MS, easing: EASE.enter },
  );
}

/** A tap away from the control: the hand and its label wiggle 5 px on X, 300 ms. */
export function guideNudge(el: Element | null): Played {
  return play(
    el,
    TOUCH_NUDGE,
    [
      { transform: 'translateX(0)', offset: 0 },
      { transform: 'translateX(-5px)', offset: 0.25 },
      { transform: 'translateX(5px)', offset: 0.75 },
      { transform: 'translateX(0)', offset: 1 },
    ],
    { duration: GUIDE_NUDGE_MS, easing: EASE.enter },
  );
}
