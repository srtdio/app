// The nav icon nudge (docs/motion.md, small touches): a nav icon nudges once when
// its unread count rises on screen. (A pick in a single-choice row switches
// instantly: no fill slide, decided 5 Nov 2026.)

import { useCallback, useEffect, useRef } from 'react';
import { nudgeIcon } from './moves';

/**
 * A nav icon whose unread count can rise: returns the ref callback for the icon's
 * own wrapper (never the badge or the link). When `count` rises on screen (not the
 * first paint, not a fall, not to zero) the icon nudges once (nudgeIcon); a newer
 * rise restarts it.
 */
export function useNudgeOnRise(count: number): (el: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  const shown = useRef<number | null>(null);
  const playing = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = count;
    if (before === null || !(count > before) || node.current === null) return;
    playing.current?.cancel();
    playing.current = nudgeIcon(node.current);
  }, [count]);
  return useCallback((el: HTMLElement | null) => {
    node.current = el;
  }, []);
}
