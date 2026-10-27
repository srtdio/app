// The one search highlight. matchRuns (src/lib/chat/search.ts) is the single
// matching rule (case-insensitive word prefix, any script), the same rule the
// search itself uses; Highlight draws its hit runs with the annotation fill and
// --fg ink, readable in light and dark. The palette and every jump destination
// render through here. glowTarget is the arrival tint a jumped-to row gets.

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { matchRuns } from '@/lib/chat/search';
import { DUR_SLOW_MS } from '@/lib/motion';
import { prefersReducedMotion } from '@/lib/use-is-laptop';

/** A searched word: the search-mark fill and its dark ink, readable on every surface in both themes. */
export const SEARCH_MARK_CLASS = 'rounded-sm bg-search-mark [color:var(--search-mark-fg)]';

/** Text with every searched word wrapped in a <mark>. Pure. */
export function highlightNodes(text: string, words: readonly string[]): ReactNode[] {
  if (words.length === 0) return text === '' ? [] : [text];
  return matchRuns(text, words).map((run, i) =>
    run.hit ? (
      <mark key={i} data-search-mark="" className={SEARCH_MARK_CLASS}>
        {run.text}
      </mark>
    ) : (
      run.text
    ),
  );
}

/** The words a jump destination colours; empty outside a search jump. */
export const SearchWordsContext = createContext<readonly string[]>([]);

/** Text with the searched words marked: `words` when given, else the screen's jump words. */
export function Highlight(props: { text: string; words?: readonly string[] }): ReactElement {
  const fromScreen = useContext(SearchWordsContext);
  return <>{highlightNodes(props.text, props.words ?? fromScreen)}</>;
}

/** When a jump's smooth scroll should have landed; a target still off screen then is snapped in. */
export const JUMP_SETTLE_MS = 700;

/** How long an arrived-at target keeps its tint before it fades. */
export const GLOW_MS = 2000;

/**
 * Tint an arrived-at row for 2s, then fade the tint out (reduced motion: no
 * fade, the tint just clears at 2s). Returns the cleanup, which clears the
 * timers and the tint. Inline styles, so no row class is ever touched.
 */
export function tintTarget(el: HTMLElement): () => void {
  const reduced = prefersReducedMotion();
  const prev = { background: el.style.backgroundColor, transition: el.style.transition };
  el.setAttribute('data-jump-glow', '');
  el.style.transition = 'none';
  el.style.backgroundColor = 'var(--accent-soft)';
  let fadeTimer: number | null = null;
  const restore = (): void => {
    el.removeAttribute('data-jump-glow');
    el.style.backgroundColor = prev.background;
    el.style.transition = prev.transition;
  };
  const holdTimer = window.setTimeout(() => {
    if (reduced) {
      restore();
      return;
    }
    el.style.transition = `background-color ${DUR_SLOW_MS}ms var(--ease-exit)`;
    el.style.backgroundColor = prev.background;
    fadeTimer = window.setTimeout(restore, DUR_SLOW_MS);
  }, GLOW_MS);
  return () => {
    window.clearTimeout(holdTimer);
    if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    restore();
  };
}

/**
 * Scroll a jump target to the centre of its scroller and tint it (tintTarget).
 * Returns the cleanup, which clears the timers and the tint (call it on
 * unmount). Comment links land through useFocusTarget (src/lib/focus-target.ts),
 * which centres in the row's own scroller instead.
 */
export function glowTarget(el: HTMLElement): () => void {
  const reduced = prefersReducedMotion();
  el.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  // A smooth scroll can be cut short when rows above it change height while it
  // runs (images and previews settling, seen on iPhone Safari): once it should
  // have finished, a target still off screen is brought in without animation.
  const settleTimer = window.setTimeout(() => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= window.innerHeight) el.scrollIntoView?.({ block: 'center' });
  }, JUMP_SETTLE_MS);
  const untint = tintTarget(el);
  return () => {
    window.clearTimeout(settleTimer);
    untint();
  };
}
