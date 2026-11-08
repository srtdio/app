// Catch up's card swipe (motion law): the card follows the finger on X and
// leans with it, rotate up to 6deg, never Y; the stack below never moves.
// Past the threshold a right swipe is Mark as read and a left swipe Keep
// unread; below it the card springs home. The fly-out and the spring run
// through the one player (src/lib/motion play), instant under Reduce Motion,
// never a fade. Pure frame math plus the two moves.

import { DUR_SLOW_MS, EASE, play, type MoveSpec, type Played } from '@/lib/motion';

/** The card's swing: X and rotate only. */
export const CARD_SWING: MoveSpec = { move: 'touch', axis: ['x', 'rotate'] };

/** The most the card leans, in degrees. */
export const SWIPE_ROTATE_MAX = 6;

/** How far (share of the card's width) a swipe must travel to decide. */
export const SWIPE_DECIDE_SHARE = 0.3;

/** The decision a swipe of `dx` px on a card `width` px wide makes, or null (springs back). Pure. */
export function swipeDecision(dx: number, width: number): 'read' | 'keep' | null {
  const at = Math.max(1, width) * SWIPE_DECIDE_SHARE;
  if (dx >= at) return 'read';
  if (dx <= -at) return 'keep';
  return null;
}

/** The lean for `dx`: proportional to the travel, capped at SWIPE_ROTATE_MAX either way. Pure. */
export function swipeRotate(dx: number, width: number): number {
  const deg = (dx / Math.max(1, width)) * SWIPE_ROTATE_MAX * 2;
  return Math.max(-SWIPE_ROTATE_MAX, Math.min(SWIPE_ROTATE_MAX, deg));
}

/** The card's transform at `dx`: translateX + rotate, never a Y. Pure. */
export function swipeTransform(dx: number, width: number): string {
  if (dx === 0) return '';
  const deg = Math.round(swipeRotate(dx, width) * 100) / 100;
  return `translateX(${Math.round(dx)}px) rotate(${deg}deg)`;
}

/** How far a decided card flies out: past its own width. Pure. */
export function flyOutDx(decision: 'read' | 'keep', width: number): number {
  return (decision === 'read' ? 1 : -1) * Math.max(1, width) * 1.4;
}

/** The tint a swipe shows: the decision it would make once past half the threshold. Pure. */
export function swipeTint(dx: number, width: number): 'read' | 'keep' | null {
  const at = Math.max(1, width) * SWIPE_DECIDE_SHARE * 0.5;
  if (dx >= at) return 'read';
  if (dx <= -at) return 'keep';
  return null;
}

/** Fly the card out from `fromDx` (0 for a button press); it holds the end pose until replaced. */
export function flyOut(el: HTMLElement | null, decision: 'read' | 'keep', fromDx: number): Played {
  const width = el?.offsetWidth ?? 0;
  const to = flyOutDx(decision, width);
  return play(
    el,
    CARD_SWING,
    [
      { transform: swipeTransform(fromDx, width) || 'none' },
      { transform: swipeTransform(to, width) },
    ],
    { duration: DUR_SLOW_MS, easing: EASE.exit, fill: 'forwards' },
  );
}

/** Spring the card home from `fromDx` (it already rests at its final, unmoved pose). */
export function springHome(el: HTMLElement | null, fromDx: number): Played {
  const width = el?.offsetWidth ?? 0;
  return play(el, CARD_SWING, [{ transform: swipeTransform(fromDx, width) || 'none' }, { transform: 'none' }], {
    duration: DUR_SLOW_MS,
    easing: EASE.enter,
  });
}
