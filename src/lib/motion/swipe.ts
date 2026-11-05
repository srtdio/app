// The swipe follow (docs/motion.md, small touches): a bubble (swipe to reply)
// or a task row (swipe to delete) follows the finger on X, and springs home on
// release over DUR_SLOW_MS with the enter curve. The icon behind it follows the
// frame with no motion of its own (scale and opacity set per frame, never
// animated): the translateX spring is the only animation. The controller
// (src/lib/chat/swipe-reply.ts) decides the frames; this paints them. Axis: x.
import type { SwipeFrame } from '@/lib/chat/swipe-reply';
import type { MoveSpec } from './run';
import { DUR_SLOW_MS } from './tokens';

export const SWIPE_FOLLOW: MoveSpec = { move: 'touch', axis: ['x'] };

/**
 * Paint one swipe frame: `slider` is translated by the frame's offset (its
 * magnitude; `direction` 'left' mirrors it), `icon` (behind the slider's
 * resting edge) scales and shows with the progress and takes data-armed at the
 * trigger. The compositor hint lives only while the finger drags; the spring
 * (animate) runs only on release and never under Reduce Motion (the
 * controller clears animate then).
 */
export function paintSwipe(
  slider: HTMLElement | null,
  icon: HTMLElement | null,
  frame: SwipeFrame,
  direction: 'right' | 'left' = 'right',
): void {
  const moved = frame.offset > 0;
  const offset = direction === 'left' ? -frame.offset : frame.offset;
  const spring = frame.animate ? `${DUR_SLOW_MS}ms var(--ease-enter)` : '';
  if (slider !== null) {
    slider.style.willChange = frame.dragging ? 'transform' : '';
    slider.style.transition = spring !== '' ? `transform ${spring}` : '';
    slider.style.transform = moved ? `translate3d(${offset}px,0,0)` : '';
  }
  if (icon !== null) {
    icon.style.transition = '';
    icon.style.opacity = moved ? String(frame.progress) : '';
    icon.style.transform = moved ? `scale(${frame.progress})` : '';
    icon.toggleAttribute('data-armed', frame.armed);
  }
}
