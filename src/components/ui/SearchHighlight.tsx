// The one search-highlight component: a text with every searched word coloured
// (the palette's matching rule), plus the hook a destination uses to read the
// words its link carried. Accent tokens only, readable in light and dark.

import { useContext, useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { highlightRuns, SEARCH_TERM_PARAM, termWords } from '@/lib/search/search-jump';

/**
 * The words this screen's link carried (?q=); none without one, and none
 * outside a router (a standalone render). Stable per term. They stay while the
 * screen's URL keeps the term, so leaving the screen clears them.
 */
export function useSearchWords(): readonly string[] {
  // The location context is null outside a router; reading it never throws.
  const location = useContext(UNSAFE_LocationContext) as { location?: { search: string } } | null;
  const term = searchTermOf(location?.location?.search ?? '');
  return useMemo(() => termWords(term), [term]);
}

function searchTermOf(search: string): string {
  return new URLSearchParams(search).get(SEARCH_TERM_PARAM) ?? '';
}

/** A text with each searched word coloured; plain text without words. */
export function Highlight({
  text,
  words,
  tone = 'text',
}: {
  text: string;
  words: readonly string[];
  /** 'tint' for text that is already accent (a mention): the match sits on the soft tint. */
  tone?: 'text' | 'tint';
}): ReactElement {
  if (words.length === 0) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, words).map((run, i) =>
        run.hit ? (
          <mark
            key={i}
            data-search-match=""
            className={
              tone === 'tint'
                ? 'rounded-sm bg-accent-soft font-semibold text-accent'
                : 'rounded-sm bg-transparent font-semibold text-accent'
            }
          >
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The same, as a node: the text itself (a plain string) without words, so a
 * screen not reached from search renders exactly as before.
 */
export function highlightText(
  text: string,
  words: readonly string[],
  tone: 'text' | 'tint' = 'text',
): ReactNode {
  return words.length === 0 ? text : <Highlight text={text} words={words} tone={tone} />;
}
