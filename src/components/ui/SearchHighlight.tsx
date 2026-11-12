// The one search highlight. matchRuns (src/lib/chat/search.ts) is the single
// matching rule (case-insensitive word prefix, any script), the same rule the
// search itself uses; Highlight draws its hit runs with the search-mark fill and
// --fg ink, readable in light and dark. The palette and every jump destination
// render through here. glowTarget is the arrival tint a jumped-to row gets; it
// wipes away left to right (wipeAway), never fades.

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { matchRuns } from '@/lib/chat/search';
import { wipeAway, type Played } from '@/lib/motion';
import { prefersReducedMotion } from '@/lib/use-is-laptop';

/** A searched word: the search-mark fill and its dark ink, readable on every surface in both themes. */
export const SEARCH_MARK_CLASS = 'rounded-sm bg-search-mark [color:var(--search-mark-fg)]';

/** Text with every searched word wrapped in a <mark>. Pure. */
export function highlightNodes(text: string, words: readonly string[]): ReactNode[] {
  if (words.length === 0) return text === '' ? [] : [text];
  // Each run is keyed by its character offset in the text (stable per text).
  let at = 0;
  return matchRuns(text, words).map((run) => {
    const start = at;
    at += run.text.length;
    return run.hit ? (
      <mark key={start} data-search-mark="" className={SEARCH_MARK_CLASS}>
        {run.text}
      </mark>
    ) : (
      run.text
    );
  });
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

/** How long an arrived-at target keeps its tint before it wipes away. */
export const GLOW_MS = 2000;

/** The arrival layer: the selected look, its 1px edge drawn by the layer's own border. */
export const GLOW_LAYER_CLASS = 'lit-selected border rounded-lg';

/** The room the arrival mark keeps around the row's content (12 Nov 2026): 8 on every side. */
export const GLOW_PAD_PX = 8;

/**
 * Where the arrival layer sits inside a row, from the row's own padding: 8
 * outside the content on every side, so the line never touches a photo, a
 * descender or an emoji. Sideways it never leaves the row (a full-bleed row's
 * 16 padding gives the 8); up and down it may reach 8 past a row with no
 * padding of its own. Pure.
 */
export function glowInset(pad: { top: number; right: number; bottom: number; left: number }): {
  top: string;
  right: string;
  bottom: string;
  left: string;
} {
  const px = (n: number): string => `${n}px`;
  return {
    top: px(pad.top - GLOW_PAD_PX),
    bottom: px(pad.bottom - GLOW_PAD_PX),
    left: px(Math.max(0, pad.left - GLOW_PAD_PX)),
    right: px(Math.max(0, pad.right - GLOW_PAD_PX)),
  };
}

/**
 * Tint an arrived-at row for 2s, then wipe the tint away left to right
 * (wipeAway, clip axis, DUR_WIPE_MS; never a fade). Motion off: the tint just
 * clears at 2s. The tint is its own layer laid behind the row's content
 * (z-index -1 inside an isolated row), so the row's own classes and inline
 * background are never touched and the clip never cuts the row's content.
 * Returns the cleanup, which clears the timer, the wipe and the tint.
 */
export function tintTarget(el: HTMLElement): () => void {
  const prev = {
    position: el.style.position,
    isolation: el.style.isolation,
    transition: el.style.transition,
  };
  el.setAttribute('data-jump-glow', '');
  // The row itself never animates: only the tint layer below moves (wipe).
  el.style.transition = 'none';
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.style.isolation = 'isolate';
  const layer = document.createElement('span');
  layer.setAttribute('data-jump-glow-layer', '');
  layer.setAttribute('aria-hidden', 'true');
  // The arrival mark is the one selected look (lit-selected: its fill and edge
  // line), never an accent tint.
  layer.className = GLOW_LAYER_CLASS;
  const cs = getComputedStyle(el);
  const pad = (v: string): number => Number.parseFloat(v) || 0;
  Object.assign(layer.style, {
    position: 'absolute',
    ...glowInset({
      top: pad(cs.paddingTop),
      right: pad(cs.paddingRight),
      bottom: pad(cs.paddingBottom),
      left: pad(cs.paddingLeft),
    }),
    zIndex: '-1',
    pointerEvents: 'none',
  });
  el.appendChild(layer);
  let wipe: Played | null = null;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    el.removeAttribute('data-jump-glow');
    layer.remove();
    el.style.position = prev.position;
    el.style.isolation = prev.isolation;
    el.style.transition = prev.transition;
  };
  const holdTimer = window.setTimeout(() => {
    if (!layer.isConnected) {
      restore();
      return;
    }
    wipe = wipeAway(layer);
    if (wipe.instant) restore();
    else void wipe.done.then(restore);
  }, GLOW_MS);
  return () => {
    window.clearTimeout(holdTimer);
    wipe?.finish();
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
