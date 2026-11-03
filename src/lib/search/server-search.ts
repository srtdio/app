// Server-side list search, shared by the list screens (Pipeline, Briefs,
// Assets, Plan, Activity). One rule everywhere: a search fires from
// SEARCH_MIN_CHARS (2) characters, SEARCH_DEBOUNCE_MS (250ms) after the last
// keystroke, and a newer query aborts the request in flight (AbortController);
// under 2 characters the screen shows its normal list and nothing is sent.
// Only typing starts a search: a screen with no query never calls the runner's
// fetch, so a page load adds no request.
//
// Also here: the PostgREST helpers for the two screens that search through a
// table read (Briefs, Assets): the ILIKE value quoted for an or() list, and
// one or() that ANDs the keyset cursor with the search.
//
// No `@/` imports: brief-list.ts and assets.ts import this module, and the
// briefs DB suite loads brief-list.ts without the app's path alias. The limits
// are the chat search's (src/lib/chat/search.ts), pinned equal by a test.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Shortest query a list screen sends (chat/search SEARCH_MIN_CHARS). */
export const SERVER_SEARCH_MIN_CHARS = 2;
/** Longest query sent; longer is no search (chat/search's limit). */
export const SERVER_SEARCH_MAX_CHARS = 100;
/** Typing settles this long before a search goes out (chat/search SEARCH_DEBOUNCE_MS). */
export const SERVER_SEARCH_DEBOUNCE_MS = 250;

/** The query a screen sends: trimmed, or '' under 2 (or over 100) characters. Pure. */
export function serverSearchQuery(raw: string): string {
  const query = raw.trim();
  return query.length >= SERVER_SEARCH_MIN_CHARS && query.length <= SERVER_SEARCH_MAX_CHARS
    ? query
    : '';
}

/**
 * A query builder with `signal` attached (supabase-js abortSignal), or as it is
 * when there is no signal or the builder cannot take one. The same rule as
 * chat-reads' abortable, kept here so this module needs no app import.
 */
export function withAbort<Q>(query: Q, signal: AbortSignal | undefined): Q {
  if (signal === undefined) return query;
  const attach = (query as { abortSignal?: (signal: AbortSignal) => Q }).abortSignal;
  return typeof attach === 'function' ? attach.call(query, signal) : query;
}

/** Escape LIKE metacharacters (backslash, %, _) so typed text matches literally. Pure. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * A value as a PostgREST double-quoted literal: backslash and double quote are
 * escaped, so commas, dots and parentheses in the value are never read as
 * filter syntax. Pure.
 */
export function quotePostgrest(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * The or() list matching `query` as a case-insensitive substring of any of
 * `columns`: `col.ilike."%q%"` per column, the LIKE metacharacters escaped,
 * then the whole pattern quoted. '' (no filter) under 2 characters. Pure.
 */
export function ilikeAnyFilter(columns: readonly string[], raw: string): string {
  const query = serverSearchQuery(raw);
  if (query === '') return '';
  const value = quotePostgrest(`%${escapeLike(query)}%`);
  return columns.map((column) => `${column}.ilike.${value}`).join(',');
}

/**
 * Two or() lists as ONE or() argument whose result is both of them: each list
 * wrapped as or(...) inside and(...), so a keyset cursor and a search always
 * AND (one `or` query param, never two that a server could merge). A blank side
 * is left out; both blank is ''. Pure.
 */
export function andOrFilters(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return `and(or(${a}),or(${b}))`;
}

export type ServerSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

/** What a screen draws for its search. `data` is the last answer (kept while the next loads). */
export interface ServerSearchState<T> {
  /** The query `data` answers, or is loading ('' when idle). */
  query: string;
  status: ServerSearchStatus;
  data: T | null;
}

export const IDLE_SERVER_SEARCH: ServerSearchState<never> = {
  query: '',
  status: 'idle',
  data: null,
};

type SearchAnswer<T> = { ok: true; data: T } | { ok: false; error: unknown };

/** One search request: the query (already normalized) and the signal a newer query aborts. */
export type ServerSearchFetch<T> = (query: string, signal: AbortSignal) => Promise<SearchAnswer<T>>;

export interface ServerSearchRunner<T> {
  /** A keystroke: under 2 characters goes idle at once; else debounced, aborting the one in flight. */
  setQuery: (raw: string) => void;
  /** Ask again for the current query now (Retry, a workspace or filter change). No query: no call. */
  refresh: () => void;
  /** Edit the shown answer in place (Load more appends, an own write). */
  update: (edit: (data: T) => T) => void;
  dispose: () => void;
}

/**
 * The search state machine every screen shares. Timers are injectable for
 * tests. An answer for an older query, or after dispose, is dropped.
 */
export function createServerSearchRunner<T>(options: {
  fetch: ServerSearchFetch<T>;
  onChange: (state: ServerSearchState<T>) => void;
  debounceMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): ServerSearchRunner<T> {
  const debounceMs = options.debounceMs ?? SERVER_SEARCH_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let state: ServerSearchState<T> = IDLE_SERVER_SEARCH;
  let generation = 0;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let disposed = false;

  const emit = (next: ServerSearchState<T>): void => {
    state = next;
    if (!disposed) options.onChange(next);
  };
  const stop = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  const run = (query: string, gen: number): void => {
    timer = null;
    const ctl = new AbortController();
    controller = ctl;
    const settle = (answer: SearchAnswer<T>): void => {
      if (gen !== generation || disposed) return;
      controller = null;
      emit(
        answer.ok
          ? { query, status: 'ready', data: answer.data }
          : { query, status: 'error', data: state.data },
      );
    };
    void options.fetch(query, ctl.signal).then(settle, (error: unknown) => {
      settle({ ok: false, error });
    });
  };
  const start = (query: string, delay: number): void => {
    generation += 1;
    stop();
    if (query === '') {
      if (state.status !== 'idle') emit(IDLE_SERVER_SEARCH);
      return;
    }
    const gen = generation;
    emit({ query, status: 'loading', data: state.data });
    timer = setTimer(() => run(query, gen), delay);
  };

  return {
    setQuery: (raw) => {
      const query = serverSearchQuery(raw);
      if (query === state.query && state.status !== 'error') return;
      start(query, debounceMs);
    },
    refresh: () => {
      if (state.query !== '') start(state.query, 0);
    },
    update: (edit) => {
      if (state.data !== null) emit({ ...state, data: edit(state.data) });
    },
    dispose: () => {
      generation += 1;
      stop();
      disposed = true;
    },
  };
}

/** The runner as a hook: the state, plus Retry/refresh and in-place edits. */
export interface ServerSearch<T> extends ServerSearchState<T> {
  /** Whether the screen is in search mode (2+ characters typed). */
  active: boolean;
  refresh: () => void;
  update: (edit: (data: T) => T) => void;
}

/**
 * A screen's server search over the raw box value (usually the URL's ?q=).
 * `fetch` may change every render (the latest one runs); a change of
 * `resetKey` (workspace, stage, view) asks again for the current query. Under
 * 2 characters it is idle and calls nothing.
 */
export function useServerSearch<T>(
  raw: string,
  fetch: ServerSearchFetch<T>,
  resetKey = '',
): ServerSearch<T> {
  const [state, setState] = useState<ServerSearchState<T>>(() => {
    const query = serverSearchQuery(raw);
    return query === '' ? IDLE_SERVER_SEARCH : { query, status: 'loading', data: null };
  });
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const runnerRef = useRef<ServerSearchRunner<T> | null>(null);
  useEffect(() => {
    const runner = createServerSearchRunner<T>({
      fetch: (query, signal) => fetchRef.current(query, signal),
      onChange: setState,
    });
    runnerRef.current = runner;
    runner.setQuery(rawRef.current);
    return () => {
      runner.dispose();
      runnerRef.current = null;
    };
  }, []);
  useEffect(() => {
    runnerRef.current?.setQuery(raw);
  }, [raw]);
  const keyRef = useRef(resetKey);
  useEffect(() => {
    if (keyRef.current === resetKey) return;
    keyRef.current = resetKey;
    runnerRef.current?.refresh();
  }, [resetKey]);
  const refresh = useCallback((): void => runnerRef.current?.refresh(), []);
  const update = useCallback((edit: (data: T) => T): void => runnerRef.current?.update(edit), []);
  const active = serverSearchQuery(raw) !== '';
  return { ...(active ? state : IDLE_SERVER_SEARCH), active, refresh, update };
}
