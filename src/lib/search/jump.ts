// The one way a search result reaches its target. Every palette result carries
// the searched words (`q`) on top of the destination's existing target param
// (?comment=, ?message=, ?task=, ?asset=) or the generic `at` (a plan item in
// its plan). Destinations read both through useSearchJump (pages) or
// readSearchJump (the chat's own deep-link step), strip them from the url, and
// keep the words until the screen unmounts.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { normalizeQuery, queryWords } from '@/lib/chat/search';
import { entryUsr } from '@/lib/chat/use-history-step';

/** The searched words a destination colours. */
export const SEARCH_TERM_PARAM = 'q';
/** A target id the destination's own params do not carry (a plan item in its plan). */
export const JUMP_TARGET_PARAM = 'at';

/** A path with the searched words (and, optionally, a target) added. No query: unchanged. Pure. */
export function withSearchJump(
  path: string,
  query: string,
  targetId: string | null = null,
): string {
  const term = normalizeQuery(query);
  const extra = new URLSearchParams();
  if (term !== '') extra.set(SEARCH_TERM_PARAM, term);
  if (targetId !== null && targetId !== '') extra.set(JUMP_TARGET_PARAM, targetId);
  const tail = extra.toString();
  if (tail === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}${tail}`;
}

/** What a destination takes from the url: the words to colour and the generic target. Pure. */
export interface SearchJump {
  words: readonly string[];
  targetId: string | null;
}

export const NO_SEARCH_JUMP: SearchJump = { words: [], targetId: null };

/** The jump a url carries (words empty and target null without one). Pure. */
export function readSearchJump(params: URLSearchParams): SearchJump {
  const words = queryWords(params.get(SEARCH_TERM_PARAM) ?? '');
  const at = params.get(JUMP_TARGET_PARAM);
  return { words, targetId: at !== null && at !== '' ? at : null };
}

/** Whether a url carries a jump at all. Pure. */
export function hasSearchJump(params: URLSearchParams): boolean {
  return params.has(SEARCH_TERM_PARAM) || params.has(JUMP_TARGET_PARAM);
}

/** The params without the jump's own keys (the destination's params stay). Pure. */
export function withoutSearchJump(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(SEARCH_TERM_PARAM);
  next.delete(JUMP_TARGET_PARAM);
  return next;
}

/**
 * A page's jump: taken from the url once (then stripped with a replace, so Back
 * and a reload never re-run it) and kept until the page unmounts, i.e. until the
 * user leaves the screen. A later jump onto the same page replaces it.
 */
export function useSearchJump(enabled = true): SearchJump {
  const [searchParams, setSearchParams] = useSearchParams();
  const [jump, setJump] = useState<SearchJump>(() =>
    enabled ? readSearchJump(searchParams) : NO_SEARCH_JUMP,
  );
  const carries = enabled && hasSearchJump(searchParams);
  useEffect(() => {
    if (!carries) return;
    setJump(readSearchJump(searchParams));
    // An updater, so a destination stripping its own param in the same commit
    // (?comment=) never gets its key put back.
    setSearchParams((prev) => withoutSearchJump(prev), {
      replace: true,
      state: entryUsr(window.history.state),
    });
  }, [carries, searchParams, setSearchParams]);
  return jump;
}
