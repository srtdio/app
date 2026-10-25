import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { NoResults } from '@/components/ui/NoResults';
import { ICON_SIZE, IconChevronDown, IconChevronLeft } from '@/components/ui/icons';
import {
  normalizeQuery,
  queryWords,
  searchCounterText,
  searchQueryReady,
  stepSearchIndex,
  SEARCH_FAILED_COPY,
  type SearchHit,
  type SearchPageFetch,
  type SearchRunner,
  type SearchState,
} from '@/lib/chat/search';
import { useFadeIn, useMessageSearch } from '@/components/chat/SearchResults';

/**
 * The words the open chat's search bar is on: every bubble draws a matched
 * word as a <mark>. Empty (no marks) whenever the bar is closed.
 */
export const SearchHighlightContext = createContext<readonly string[]>([]);

/** The words a query highlights: none under 2 characters. Pure. */
export function highlightWords(query: string): string[] {
  return searchQueryReady(query) ? queryWords(query) : [];
}

/** How many next pages the bar reads looking for the tapped hit before giving up. */
const ANCHOR_PAGE_CAP = 5;

/** The counter, or nothing while the first page is still out. Pure. */
export function inChatCounter(state: SearchState, query: string, index: number): string | null {
  if (!searchQueryReady(query) || state.query !== normalizeQuery(query)) return null;
  if (state.status !== 'ready') return null;
  return searchCounterText(index, state.hits.length, state.hasMore);
}

/**
 * Close the bar: the request in flight is aborted, the debounce cleared and
 * every bubble's marks go (no words), then the header comes back.
 */
export function closeInChatSearch(deps: {
  runner: Pick<SearchRunner, 'dispose'> | null;
  onTermsChange: (words: readonly string[]) => void;
  onClose: () => void;
}): void {
  deps.runner?.dispose();
  deps.onTermsChange([]);
  deps.onClose();
}

export interface InChatSearchBarProps {
  workspaceId: string | null;
  channelId: string;
  /** The query the bar opens on ('' from the header icon). */
  initialQuery: string;
  /** Opened from a home hit: the bar sits on this match (the thread already jumped). */
  anchorMessageId: string | null;
  /** Jump the thread to a match (loads older history when needed). */
  onJump: (messageId: string) => void;
  /** The words every bubble marks; [] on close. */
  onTermsChange: (words: readonly string[]) => void;
  onClose: () => void;
  /** Tests: the page reader (the app reads Supabase). */
  fetchPage?: SearchPageFetch;
}

/**
 * The mono "N of M" ink, the 44px arrows and the input, on the header's panel.
 * FN23: 16px on a phone (iOS never zooms the page on focus), 14px from md up.
 */
export const BAR_INPUT =
  'h-11 min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-2 text-input text-fg placeholder:text-fg-3 focus:border-border-strong focus:outline-none md:px-3 md:text-base';

/**
 * The in-chat search bar, in place of the thread header: close, the input,
 * "N of M" and the arrows (up = older match, down = newer). Enter is the next
 * older match. Matches come from chat_message_search on this chat only.
 */
export function InChatSearchBar(props: InChatSearchBarProps): ReactElement {
  const { onJump, onTermsChange, onClose } = props;
  const [query, setQuery] = useState(props.initialQuery);
  const [index, setIndex] = useState(0);
  const { state, runner } = useMessageSearch({
    workspaceId: props.workspaceId,
    channelId: props.channelId,
    ...(props.fetchPage !== undefined ? { fetchPage: props.fetchPage } : {}),
  });
  const rootRef = useRef<HTMLDivElement>(null);
  useFadeIn(rootRef);
  // The anchor (a home hit) applies to the query the bar opened on, once.
  const anchorRef = useRef<{ id: string; query: string } | null>(
    props.anchorMessageId !== null
      ? { id: props.anchorMessageId, query: normalizeQuery(props.initialQuery) }
      : null,
  );
  const anchorPagesRef = useRef(0);
  // Rendered twin of anchorRef: the counter hides while the bar pages to the hit.
  const [anchoring, setAnchoring] = useState(props.anchorMessageId !== null);
  // The query whose results the index has been placed on.
  const placedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    runner?.setQuery(query);
  }, [runner, query]);

  // Bubbles mark the words being searched; closing (or unmounting) clears them.
  useEffect(() => {
    onTermsChange(highlightWords(query));
  }, [query, onTermsChange]);
  useEffect(() => () => onTermsChange([]), [onTermsChange]);

  // Fresh results: sit on the tapped hit (paging to it), else the newest match.
  useEffect(() => {
    if (state.status !== 'ready' || placedRef.current === state.query) return;
    const anchor = anchorRef.current;
    if (anchor !== null && anchor.query === state.query) {
      const at = state.hits.findIndex((h) => h.id === anchor.id);
      if (at !== -1) {
        anchorRef.current = null;
        setAnchoring(false);
        placedRef.current = state.query;
        setIndex(at);
        return;
      }
      if (state.hasMore && !state.moreFailed && anchorPagesRef.current < ANCHOR_PAGE_CAP) {
        if (!state.loadingMore) {
          anchorPagesRef.current += 1;
          void runner?.loadMore();
        }
        return;
      }
      // Not found: the thread stays on the tapped message (no jump away).
      anchorRef.current = null;
      setAnchoring(false);
      placedRef.current = state.query;
      setIndex(0);
      return;
    }
    placedRef.current = state.query;
    setIndex(0);
    const first = state.hits[0];
    if (first !== undefined) onJump(first.id);
  }, [state, runner, onJump]);

  const goTo = useCallback(
    (hits: readonly SearchHit[], next: number): void => {
      const hit = hits[next];
      if (hit === undefined) return;
      setIndex(next);
      onJump(hit.id);
    },
    [onJump],
  );

  const older = async (): Promise<void> => {
    // While paging to the tapped hit its place is unknown: no stepping yet.
    if (anchoring) return;
    if (state.status !== 'ready' || state.query !== normalizeQuery(query)) return;
    const next = stepSearchIndex(index, 'older', state.hits.length);
    if (next !== null) {
      goTo(state.hits, next);
      return;
    }
    if (!state.hasMore || runner === null) return;
    await runner.loadMore();
    if (!mountedRef.current) return;
    const after = runner.getState();
    const more = stepSearchIndex(index, 'older', after.hits.length);
    if (more !== null) goTo(after.hits, more);
  };
  const newer = (): void => {
    if (anchoring) return;
    if (state.status !== 'ready') return;
    const next = stepSearchIndex(index, 'newer', state.hits.length);
    if (next !== null) goTo(state.hits, next);
  };
  const close = (): void => closeInChatSearch({ runner, onTermsChange, onClose });

  // While the bar still pages to the tapped hit, its place is unknown: no counter.
  const counter = anchoring ? null : inChatCounter(state, query, index);
  const ready = counter !== null;
  const failed =
    searchQueryReady(query) &&
    state.query === normalizeQuery(query) &&
    (state.status === 'error' || state.moreFailed);
  const total = state.hits.length;
  // A finished search with no hit: the one NoResults state, under the bar.
  const none = ready && total === 0 && !state.hasMore;
  return (
    <div
      ref={rootRef}
      data-chat-search-bar=""
      className="relative flex min-w-0 flex-1 items-center gap-1"
    >
      <IconButton label="Close search" onClick={close}>
        <IconChevronLeft size={ICON_SIZE.control} />
      </IconButton>
      <input
        type="search"
        enterKeyHint="search"
        aria-label="Search this chat"
        placeholder="Search this chat"
        value={query}
        // From the header icon the keyboard comes up; from a home hit the match shows first.
        autoFocus={props.anchorMessageId === null}
        onChange={(e) => {
          // A new query is placed afresh, even when retyped to an earlier one.
          if (normalizeQuery(e.target.value) !== normalizeQuery(query)) {
            placedRef.current = null;
            // Typing over the tapped hit's query drops the anchor.
            anchorRef.current = null;
            setAnchoring(false);
          }
          setQuery(e.target.value);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          // Enter while an IME is composing commits the word, never steps.
          // WebKit sends the commit Enter after compositionend with keyCode 229.
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
            return;
          }
          e.preventDefault();
          void older();
        }}
        className={BAR_INPUT}
      />
      <span
        data-search-counter=""
        aria-live="polite"
        className="min-w-[44px] shrink-0 text-center font-mono text-sm tabular-nums text-fg-2"
      >
        {counter ?? ''}
      </span>
      <IconButton
        label="Older match"
        disabled={!ready || (index >= total - 1 && !state.hasMore)}
        onClick={() => void older()}
        className="disabled:opacity-40"
      >
        <IconChevronDown size={ICON_SIZE.control} className="-scale-y-100" />
      </IconButton>
      <IconButton
        label="Newer match"
        disabled={!ready || index <= 0}
        onClick={newer}
        className="disabled:opacity-40"
      >
        <IconChevronDown size={ICON_SIZE.control} />
      </IconButton>
      {failed ? (
        <PressableRow
          type="button"
          data-search-retry=""
          onClick={() => runner?.retry()}
          flat
          className="absolute left-0 right-0 top-full z-10 mt-px flex items-center justify-center border-b border-border bg-panel px-3 text-base text-fg-2"
        >
          {SEARCH_FAILED_COPY}
        </PressableRow>
      ) : none ? (
        <div
          data-search-none=""
          className="absolute left-0 right-0 top-full z-10 mt-px border-b border-border bg-panel"
        >
          <NoResults query={query} filtersActive={false} onClear={() => setQuery('')} />
        </div>
      ) : null}
    </div>
  );
}
