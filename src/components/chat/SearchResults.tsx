import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { PreviewNameOf } from '@/lib/chat/chat-store';
import {
  createSearchRunner,
  IDLE_SEARCH,
  matchRuns,
  normalizeQuery,
  queryWords,
  searchDateLabel,
  searchMessages,
  searchQueryReady,
  searchReady,
  searchSenderPrefix,
  snippetText,
  SEARCH_EMPTY_COPY,
  SEARCH_FAILED_COPY,
  type SearchHit,
  type SearchKind,
  type SearchPageFetch,
  type SearchRunner,
  type SearchState,
} from '@/lib/chat/search';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { NotesAvatar } from '@/components/chat/NotesBits';

/**
 * The search runner for one surface (chat home, or one chat's bar): created per
 * workspace and chat, disposed (request aborted, debounce cleared) on unmount
 * and whenever either changes. `fetchPage` is for tests; the app reads Supabase.
 */
export function useMessageSearch(params: {
  workspaceId: string | null;
  channelId?: string | null;
  fetchPage?: SearchPageFetch;
}): { state: SearchState; runner: SearchRunner | null } {
  const { workspaceId, fetchPage } = params;
  const channelId = params.channelId ?? null;
  const [state, setState] = useState<SearchState>(IDLE_SEARCH);
  const [runner, setRunner] = useState<SearchRunner | null>(null);
  useEffect(() => {
    if (workspaceId === null) return;
    const fetch: SearchPageFetch =
      fetchPage ??
      (({ query, before, signal, kind }) =>
        searchMessages({
          client: supabase,
          workspaceId,
          query,
          before,
          signal,
          channelId,
          kind: kind ?? null,
        }));
    const next = createSearchRunner({ fetch, onChange: setState });
    setRunner(next);
    setState(IDLE_SEARCH);
    return () => {
      next.dispose();
      setRunner(null);
    };
  }, [workspaceId, channelId, fetchPage]);
  return { state, runner };
}

/** Users who asked for less motion get no fade. */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Fade an element in on mount: opacity only (no movement, no scale). Runs
 * before paint, so the first frame is already the final layout.
 */
export function useFadeIn(ref: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof el.animate !== 'function') return;
    if (typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches) {
      return;
    }
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      easing: 'ease-out',
    });
    return () => animation.cancel();
  }, [ref]);
}

/** Section label, matching the chat home's Groups / People labels. */
const RESULT_LABEL = 'px-1 pt-1 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

/** A result row: one 64px tap target, no text selection and no iOS callout on hold. */
const RESULT_ROW = cn(
  'group/notes-row flex min-h-[64px] w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);

/** The 48px result avatar: a group's rounded square, a person's circle, the notes notebook. */
function resultAvatar(channel: ChannelSummary): ReactElement {
  if (channel.channelType === 'notes') {
    return <NotesAvatar size="small" src={channel.avatarUrl} surface="bg" hoverSurface="panel-2" />;
  }
  return (
    <span className={cn('flex shrink-0', channel.channelType === 'group' && '[&>*]:!rounded-xl')}>
      <Avatar
        name={channel.title}
        {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
        size="row"
        shape={channel.channelType === 'group' ? 'rounded' : 'circle'}
      />
    </span>
  );
}

/** A chat's name with the part the name search matched in accent ink. Pure. */
export function highlightName(title: string, query: string): ReactNode {
  const q = normalizeQuery(query).toLowerCase();
  const at = q === '' ? -1 : title.toLowerCase().indexOf(q);
  if (at === -1) return title;
  return (
    <>
      {title.slice(0, at)}
      <span data-name-match="" className="text-accent">
        {title.slice(at, at + q.length)}
      </span>
      {title.slice(at + q.length)}
    </>
  );
}

/** A snippet with every matched word bold in --fg. Pure. */
export function boldMatches(text: string, words: readonly string[]): ReactNode[] {
  return matchRuns(text, words).map((run, i) =>
    run.hit ? (
      <b key={i} data-search-match="" className="font-semibold text-fg">
        {run.text}
      </b>
    ) : (
      <span key={i}>{run.text}</span>
    ),
  );
}

/** Long-press and right-click never open a native menu or callout on a row. */
function noCallout(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

export interface SearchResultsProps {
  /** The text in the search box (2+ trimmed chars, or any with a chip, while this shows). */
  query: string;
  /** The active filter chip; absent or null without one. */
  kind?: SearchKind | null;
  /** The name search's matches (hidden chats included). */
  chats: readonly ChannelSummary[];
  state: SearchState;
  /** Every chat in the roster (hidden included), for hit names and avatars. */
  channelsById: ReadonlyMap<string, ChannelSummary>;
  currentUserId: string | null;
  /** Names already loaded (group sender first names, mentions). */
  nameOf: PreviewNameOf;
  nowMs: number;
  timeZone: string;
  onOpenChat: (channel: ChannelSummary) => void;
  onOpenHit: (channel: ChannelSummary, hit: SearchHit, query: string) => void;
  onRetry: () => void;
  /** The end-of-list marker the next-page observer watches. */
  sentinelRef?: RefObject<HTMLLIElement>;
}

/** Skeleton rows while the first page of messages loads. */
const LOADING_ROWS = 3;

/**
 * The results body: "Chats" (name matches) then "Messages" (server hits,
 * newest first). Hook-free so every state is unit tested.
 */
export function searchResultsView(props: SearchResultsProps): ReactElement {
  const query = normalizeQuery(props.query);
  const kind = props.kind ?? null;
  // A chip with too short a query lists by the chip alone: nothing to bold.
  const words = searchQueryReady(query) ? queryWords(query) : [];
  // Past the server's 100 characters there is nothing to wait for: no messages.
  const sendable = searchReady(query, kind);
  const current = props.state.query === query && props.state.kind === kind;
  const loading =
    sendable && (!current || props.state.status === 'loading' || props.state.status === 'idle');
  const failed = current && props.state.status === 'error';
  const hits = current && props.state.status === 'ready' ? props.state.hits : [];
  const rows = hits.flatMap((hit) => {
    const channel = props.channelsById.get(hit.channelId);
    return channel !== undefined ? [{ hit, channel }] : [];
  });
  const retryRow = (
    <li>
      <button
        type="button"
        data-search-retry=""
        onClick={props.onRetry}
        className="flex min-h-[44px] w-full items-center justify-center rounded-lg px-3 text-base text-fg-2 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {SEARCH_FAILED_COPY}
      </button>
    </li>
  );
  return (
    <div data-search-results="" className="flex flex-col gap-2 px-[14px] pb-4">
      {props.chats.length > 0 && kind === null ? (
        <>
          <h3 data-section-label="chats" className={RESULT_LABEL}>
            Chats
          </h3>
          <ul data-section="chats" className="flex flex-col">
            {props.chats.map((channel) => (
              <li key={channel.channelId} className="min-w-0">
                <button
                  type="button"
                  aria-label={`Open ${channel.title}`}
                  onClick={() => props.onOpenChat(channel)}
                  onContextMenu={noCallout}
                  className={RESULT_ROW}
                >
                  {resultAvatar(channel)}
                  <span className="min-w-0 flex-1 truncate text-lg font-semibold leading-5 text-fg">
                    {highlightName(channel.title, query)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 data-section-label="messages" className={RESULT_LABEL}>
        Messages
      </h3>
      <ul data-section="messages" className="flex flex-col">
        {loading ? (
          Array.from({ length: LOADING_ROWS }, (_, i) => (
            <li key={i} data-search-skeleton="" className="flex items-center gap-3 px-2 py-2">
              <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-panel-2" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="h-3.5 w-1/3 animate-pulse rounded bg-panel-2" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-panel-2" />
              </div>
            </li>
          ))
        ) : failed ? (
          retryRow
        ) : rows.length === 0 ? (
          <li data-search-empty="" className="px-2 py-6 text-center text-base text-fg-2">
            {SEARCH_EMPTY_COPY}
          </li>
        ) : (
          rows.map(({ hit, channel }) => {
            // Notes are all mine: no "You:" before the line.
            const prefix =
              channel.channelType === 'notes'
                ? ''
                : searchSenderPrefix({
                    senderUserId: hit.senderUserId,
                    currentUserId: props.currentUserId,
                    isGroup: channel.channelType === 'group',
                    nameOf: props.nameOf,
                  });
            return (
              <li key={hit.id} className="min-w-0">
                <button
                  type="button"
                  data-search-hit={hit.id}
                  aria-label={`Open message in ${channel.title}`}
                  onClick={() => props.onOpenHit(channel, hit, query)}
                  onContextMenu={noCallout}
                  className={RESULT_ROW}
                >
                  {resultAvatar(channel)}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-lg font-semibold leading-5 text-fg">
                        {channel.title}
                      </span>
                      <span
                        data-search-date=""
                        className="shrink-0 font-mono text-sm tabular-nums text-fg-2"
                      >
                        {searchDateLabel(hit.createdAt, props.nowMs, props.timeZone)}
                      </span>
                    </span>
                    <span
                      data-search-snippet=""
                      className="line-clamp-2 break-words text-base text-fg-2"
                    >
                      {prefix !== '' ? <span>{prefix}</span> : null}
                      {hit.body.trim() === '' && hit.mediaLine !== undefined && hit.mediaLine !== ''
                        ? hit.mediaLine
                        : boldMatches(snippetText(hit.body, words, props.nameOf), words)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
        {!loading && !failed && props.state.loadingMore ? (
          <li data-search-more="" className="px-2 py-3">
            <div className="mx-auto h-3 w-1/3 animate-pulse rounded bg-panel-2" />
          </li>
        ) : null}
        {!loading && !failed && props.state.moreFailed ? retryRow : null}
        {!loading && !failed && props.state.hasMore ? (
          <li ref={props.sentinelRef} data-search-sentinel="" aria-hidden="true" className="h-px" />
        ) : null}
      </ul>
    </div>
  );
}

/**
 * The chat home's search results: the view, faded in (opacity only), with
 * an observer on the end marker that loads the next page as it scrolls in.
 */
export function SearchResults(
  props: Omit<SearchResultsProps, 'sentinelRef' | 'onRetry'> & { runner: SearchRunner | null },
): ReactElement {
  const { runner } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  useFadeIn(rootRef);
  const hasMore = props.state.hasMore;
  const loadingMore = props.state.loadingMore;
  const moreFailed = props.state.moreFailed;
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || runner === null || !hasMore || loadingMore || moreFailed) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void runner.loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [runner, hasMore, loadingMore, moreFailed, props.state.hits.length]);
  const onRetry = useCallback(() => runner?.retry(), [runner]);
  // No runner (no workspace): nothing can be searched, so no skeleton forever.
  const state: SearchState =
    runner === null
      ? {
          ...IDLE_SEARCH,
          query: normalizeQuery(props.query),
          kind: props.kind ?? null,
          status: 'ready',
        }
      : props.state;
  return <div ref={rootRef}>{searchResultsView({ ...props, state, onRetry, sentinelRef })}</div>;
}
