// Search highlight + jump: the one shared mechanism. A search result's link
// carries the searched term as ?q= next to the destination's own target param
// (?comment=, ?message=, ?item=, ?task=, ?asset=); the destination reads the
// words back with searchWordsFrom, colours them with matchRuns (the palette's
// own matching rule: case-insensitive word prefix, any script), and glows the
// target once it is on screen. Pure except glowNode, which only touches the
// node it is given.

import { matchRuns, queryWords, type MatchRun } from '@/lib/chat/search';

/** The search param a result's link carries its term in. */
export const SEARCH_TERM_PARAM = 'q';

/** How long an arrived-at target keeps its tint. */
export const GLOW_MS = 2000;

/** How long the tint takes to fade once it clears (no fade under reduced motion). */
export const GLOW_FADE_MS = 600;

/** A path with the search term added as ?q= (kept after any params it already has). Pure. */
export function withSearchTerm(path: string, term: string): string {
  const q = term.trim();
  if (q === '') return path;
  const hash = path.indexOf('#');
  const base = hash === -1 ? path : path.slice(0, hash);
  const tail = hash === -1 ? '' : path.slice(hash);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${SEARCH_TERM_PARAM}=${encodeURIComponent(q)}${tail}`;
}

/** The words a destination colours: the ?q= term split as the search splits it. Pure. */
export function searchWordsFrom(params: URLSearchParams): string[] {
  return termWords(params.get(SEARCH_TERM_PARAM) ?? '');
}

/** A raw term's words, split as the search splits it. Pure. */
export function termWords(term: string): string[] {
  return queryWords(term);
}

/** The runs of a text for the searched words (the shared matching rule). Pure. */
export function highlightRuns(text: string, words: readonly string[]): MatchRun[] {
  return matchRuns(text, words);
}

/** Whether the viewer asked for reduced motion (false where matchMedia is missing). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Tint a node for GLOW_MS, then let it fade (instant under reduced motion).
 * Inline styles only, restored afterwards, so the node's own classes never
 * change. Returns the cleanup, which also runs the reset early (unmount).
 */
export function glowNode(
  node: HTMLElement,
  opts: {
    reducedMotion?: boolean;
    ms?: number;
    schedule?: (fn: () => void, ms: number) => number;
  } = {},
): () => void {
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  const holdMs = opts.ms ?? GLOW_MS;
  const schedule = opts.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const prev = { bg: node.style.backgroundColor, transition: node.style.transition };
  node.setAttribute('data-search-glow', '');
  node.style.transition = reduced ? 'none' : `background-color ${GLOW_FADE_MS}ms ease-out`;
  node.style.backgroundColor = 'var(--accent-soft)';
  const timers: number[] = [];
  let done = false;
  const reset = (): void => {
    if (done) return;
    done = true;
    for (const t of timers) window.clearTimeout(t);
    node.style.backgroundColor = prev.bg;
    node.style.transition = prev.transition;
    node.removeAttribute('data-search-glow');
  };
  timers.push(
    schedule(() => {
      node.style.backgroundColor = prev.bg;
      if (reduced) reset();
      else timers.push(schedule(reset, GLOW_FADE_MS));
    }, holdMs),
  );
  return reset;
}

/** Scroll a node to the middle of its scroller and glow it. Returns the cleanup. */
export function arriveAt(
  node: HTMLElement,
  opts: { reducedMotion?: boolean; ms?: number } = {},
): () => void {
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  node.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  return glowNode(node, {
    reducedMotion: reduced,
    ...(opts.ms !== undefined ? { ms: opts.ms } : {}),
  });
}
