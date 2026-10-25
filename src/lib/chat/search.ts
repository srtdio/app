// Message search (UI-4): the chat_message_search wrapper, the debounced and
// abortable search runner the chat home and the in-chat bar share, and the pure
// pieces a result row draws (snippet, matched words, date label, sender prefix).
//
// chat_message_search is SECURITY INVOKER: chat_messages RLS keeps the rows to
// chats the caller is in (after their Clear chat), deleted rows are excluded,
// newest first (created_at desc, id desc). It is always called with NAMED args,
// with a fresh uuid_v7 p_trace_id per call. A filter chip passes p_kind (photo,
// voice, file, link); with a chip the query may be empty (newest matches).
// Paging is keyset: the last row's created_at and id go back as the cursor.

import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import {
  messagePreviewContent,
  previewPrefix,
  previewText,
  type PreviewNameOf,
} from '@/lib/chat/chat-store';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import { resolveMentionText } from '@/lib/chat/mentions';
import { civilDay, formatTime } from '@/lib/time';
import { generateTraceId } from '@/lib/trace';

type SearchFn = Database['public']['Functions']['chat_message_search'];
export type SearchArgs = SearchFn['Args'];
type SearchRow = SearchFn['Returns'][number];

/** Shortest and longest trimmed query the server searches (else zero rows). */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
/** One page of hits. */
export const SEARCH_PAGE_SIZE = 30;
/** Typing settles this long before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 250;

/** A filter chip's kind: chat_message_search p_kind. */
export type SearchKind = 'photo' | 'link' | 'file' | 'voice';

/** The chips under the chat home search box, in order. */
export const SEARCH_CHIPS: readonly { kind: SearchKind; label: string }[] = [
  { kind: 'photo', label: 'Photos' },
  { kind: 'link', label: 'Links' },
  { kind: 'file', label: 'Files' },
  { kind: 'voice', label: 'Voice notes' },
];

/** One chip at a time: tapping the active chip clears it, another replaces it. Pure. */
export function toggleSearchKind(
  current: SearchKind | null,
  tapped: SearchKind,
): SearchKind | null {
  return current === tapped ? null : tapped;
}

/** Whether a search goes out: 2+ characters, or a chip (alone or with text). Pure. */
export function searchReady(raw: string, kind: SearchKind | null): boolean {
  return kind !== null || searchQueryReady(raw);
}

/**
 * The p_query a call carries: the query when it is long enough, else '' when a
 * chip is set (the chip alone lists the newest matches). Pure.
 */
export function effectiveQuery(raw: string, kind: SearchKind | null): string {
  const q = normalizeQuery(raw);
  return kind !== null && !searchQueryReady(q) ? '' : q;
}

/** The failure row's copy (never connection wording). */
export const SEARCH_FAILED_COPY = "Couldn't search. Try again.";

/** One message hit, as the result rows and the in-chat bar read it. */
export interface SearchHit {
  id: string;
  channelId: string;
  senderUserId: string | null;
  body: string;
  createdAt: string;
  /**
   * The row's line when its body is empty (a chip's photo, voice note or
   * file): "Photo", "Voice message (0:12)", "File"; '' when it has a body.
   */
  mediaLine?: string;
}

/** The keyset cursor: the last row of the previous page. */
export interface SearchCursor {
  createdAt: string;
  id: string;
}

export interface SearchPage {
  hits: SearchHit[];
  /** Where the next page starts; null when this page was the last. */
  next: SearchCursor | null;
}

export type SearchResult = { ok: true; data: SearchPage } | { ok: false; error: string };

/** The query as the server sees it, trimmed. */
export function normalizeQuery(raw: string): string {
  return raw.trim();
}

/** Whether a query is long enough (and short enough) to send. Pure. */
export function searchQueryReady(raw: string): boolean {
  const q = normalizeQuery(raw);
  return q.length >= SEARCH_MIN_CHARS && q.length <= SEARCH_MAX_CHARS;
}

/**
 * The named args of one call. Optional args are left out when unset, so the
 * server defaults apply; every key is a parameter name, never a position. Pure.
 */
export function searchArgs(params: {
  workspaceId: string;
  query: string;
  traceId: string;
  channelId?: string | null;
  before?: SearchCursor | null;
  limit?: number;
  kind?: SearchKind | null;
}): SearchArgs {
  const kind = params.kind ?? null;
  return {
    p_workspace_id: params.workspaceId,
    p_query: effectiveQuery(params.query, kind),
    p_trace_id: params.traceId,
    ...(kind !== null ? { p_kind: kind } : {}),
    ...(params.channelId != null ? { p_channel_id: params.channelId } : {}),
    ...(params.before != null
      ? { p_before_created_at: params.before.createdAt, p_before_id: params.before.id }
      : {}),
    p_limit: params.limit ?? SEARCH_PAGE_SIZE,
  };
}

/** A full page means there may be more: the next cursor is its last row. Pure. */
export function nextCursor(
  rows: readonly Pick<SearchHit, 'id' | 'createdAt'>[],
  limit: number,
): SearchCursor | null {
  const last = rows[rows.length - 1];
  if (last === undefined || rows.length < limit) return null;
  return { createdAt: last.createdAt, id: last.id };
}

function toHit(row: SearchRow): SearchHit {
  const body = row.body ?? '';
  return {
    id: row.id,
    channelId: row.channel_id,
    senderUserId: row.sender_user_id,
    body,
    createdAt: row.created_at,
    mediaLine:
      body.trim() !== ''
        ? ''
        : previewText(messagePreviewContent(rowToThreadMessage(row as ChatMessageRow, ''))),
  };
}

/** Merge an outer signal (a new keystroke) with a read timeout. */
function linkedSignal(
  outer: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', abort);
    },
  };
}

/**
 * One page of chat_message_search: one RPC, named args, its own uuid_v7
 * trace id. Never throws; an abort or timeout is a failure.
 */
export async function searchMessages(params: {
  client: Client;
  workspaceId: string;
  query: string;
  signal: AbortSignal;
  channelId?: string | null;
  before?: SearchCursor | null;
  limit?: number;
  traceId?: string;
  timeoutMs?: number;
  kind?: SearchKind | null;
}): Promise<SearchResult> {
  const limit = params.limit ?? SEARCH_PAGE_SIZE;
  const args = searchArgs({
    workspaceId: params.workspaceId,
    query: params.query,
    traceId: params.traceId ?? generateTraceId(),
    channelId: params.channelId ?? null,
    before: params.before ?? null,
    limit,
    kind: params.kind ?? null,
  });
  const link = linkedSignal(params.signal, params.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    const res = await abortable(params.client.rpc('chat_message_search', args), link.signal);
    if (link.signal.aborted) return { ok: false, error: 'aborted' };
    if (res.error) return { ok: false, error: res.error.message };
    const hits = ((res.data ?? []) as SearchRow[]).map(toHit);
    return { ok: true, data: { hits, next: nextCursor(hits, limit) } };
  } catch (error: unknown) {
    return { ok: false, error: String(error) };
  } finally {
    link.done();
  }
}

/** What a search surface draws. */
export interface SearchState {
  /** The trimmed query these hits are for ('' when idle). */
  query: string;
  /** The chip these hits are for; null without one. */
  kind: SearchKind | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  hits: SearchHit[];
  /** More pages exist past the loaded hits. */
  hasMore: boolean;
  loadingMore: boolean;
  /** The last next-page read failed (the row's retry loads it again). */
  moreFailed: boolean;
}

export const IDLE_SEARCH: SearchState = {
  query: '',
  kind: null,
  status: 'idle',
  hits: [],
  hasMore: false,
  loadingMore: false,
  moreFailed: false,
};

/** One page read for the runner: the query, the cursor and this call's signal. */
export type SearchPageFetch = (request: {
  query: string;
  before: SearchCursor | null;
  signal: AbortSignal;
  /** The chip; absent or null without one. */
  kind?: SearchKind | null;
}) => Promise<SearchResult>;

export interface SearchRunner {
  /**
   * A keystroke or a chip tap: aborts the previous request, debounces the
   * next. Under 2 chars and no chip: idle, no call.
   */
  setQuery: (raw: string, kind?: SearchKind | null) => void;
  /** The next page (keyset); resolves once it settled. No-op without more pages. */
  loadMore: () => Promise<void>;
  /** Re-run the failed read (first page or next page). */
  retry: () => void;
  getState: () => SearchState;
  /** Abort the request and clear the timer (unmount, chat switch, Cancel). */
  dispose: () => void;
}

/**
 * The search state machine. Each keystroke aborts the request in flight and
 * restarts the debounce; an answer for any query other than the latest is
 * dropped. Timers are injectable for tests.
 */
export function createSearchRunner(options: {
  fetch: SearchPageFetch;
  onChange: (state: SearchState) => void;
  debounceMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): SearchRunner {
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let state: SearchState = IDLE_SEARCH;
  let generation = 0;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let cursor: SearchCursor | null = null;
  let disposed = false;

  const emit = (next: SearchState): void => {
    state = next;
    if (!disposed) options.onChange(next);
  };
  const stop = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  const request = (query: string, kind: SearchKind | null) =>
    kind !== null ? { query: effectiveQuery(query, kind), kind } : { query };

  const runFirst = (query: string, kind: SearchKind | null, gen: number): void => {
    timer = null;
    const ctl = new AbortController();
    controller = ctl;
    void options
      .fetch({ ...request(query, kind), before: null, signal: ctl.signal })
      .then((result) => {
        if (gen !== generation || disposed) return;
        controller = null;
        if (!result.ok) {
          emit({ ...IDLE_SEARCH, query, kind, status: 'error' });
          return;
        }
        cursor = result.data.next;
        emit({
          ...IDLE_SEARCH,
          query,
          kind,
          status: 'ready',
          hits: result.data.hits,
          hasMore: cursor !== null,
        });
      });
  };

  const setQuery = (raw: string, kindIn: SearchKind | null = null): void => {
    const query = normalizeQuery(raw);
    const kind = kindIn ?? null;
    if (
      query === state.query &&
      kind === state.kind &&
      state.status !== 'idle' &&
      state.status !== 'error'
    )
      return;
    generation += 1;
    stop();
    cursor = null;
    if (!searchReady(query, kind)) {
      emit(IDLE_SEARCH);
      return;
    }
    const gen = generation;
    emit({ ...IDLE_SEARCH, query, kind, status: 'loading' });
    timer = setTimer(() => runFirst(query, kind, gen), debounceMs);
  };

  const loadMore = async (): Promise<void> => {
    if (state.status !== 'ready' || !state.hasMore || state.loadingMore || cursor === null) return;
    const gen = generation;
    const query = state.query;
    const kind = state.kind;
    const ctl = new AbortController();
    controller = ctl;
    emit({ ...state, loadingMore: true, moreFailed: false });
    const result = await options.fetch({
      ...request(query, kind),
      before: cursor,
      signal: ctl.signal,
    });
    if (gen !== generation || disposed) return;
    controller = null;
    if (!result.ok) {
      emit({ ...state, loadingMore: false, moreFailed: true });
      return;
    }
    cursor = result.data.next;
    const seen = new Set(state.hits.map((h) => h.id));
    emit({
      ...state,
      hits: [...state.hits, ...result.data.hits.filter((h) => !seen.has(h.id))],
      hasMore: cursor !== null,
      loadingMore: false,
      moreFailed: false,
    });
  };

  const retry = (): void => {
    if (state.status === 'error') {
      const query = state.query;
      const kind = state.kind;
      generation += 1;
      stop();
      const gen = generation;
      emit({ ...IDLE_SEARCH, query, kind, status: 'loading' });
      runFirst(query, kind, gen);
      return;
    }
    if (state.moreFailed) void loadMore();
  };

  return {
    setQuery,
    loadMore,
    retry,
    getState: () => state,
    dispose: () => {
      generation += 1;
      stop();
      disposed = true;
    },
  };
}

/** The words of a query, as the server splits them (letters, marks, digits). Pure. */
export function queryWords(raw: string): string[] {
  const words = normalizeQuery(raw).toLowerCase().match(WORD) ?? [];
  return [...new Set(words)];
}

/** A word: letters with their combining marks (Devanagari matras) and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** One run of text: matched (a word starting with a query word) or not. */
export interface MatchRun {
  text: string;
  hit: boolean;
}

/**
 * Split text into runs, each word that starts with a query word (prefix,
 * case-insensitive, any script) a hit run. No words: one plain run. Pure.
 */
export function matchRuns(text: string, words: readonly string[]): MatchRun[] {
  if (words.length === 0 || text === '') return text === '' ? [] : [{ text, hit: false }];
  const runs: MatchRun[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (!words.some((w) => lower.startsWith(w))) continue;
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at), hit: false });
    runs.push({ text: word, hit: true });
    last = at + word.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), hit: false });
  return runs;
}

/** Characters kept before the first match when the snippet is cut. */
const SNIPPET_LEAD = 24;
/** The snippet's longest run (two lines of a result row, with room to spare). */
export const SNIPPET_MAX = 140;
const ELLIPSIS = '…';

/**
 * A result row's line: mentions as "@Name" (never the raw token), whitespace
 * folded, starting near the first matched word and cut with an ellipsis. Pure.
 */
export function snippetText(
  body: string,
  words: readonly string[],
  nameOf: PreviewNameOf,
  max: number = SNIPPET_MAX,
): string {
  const text = resolveMentionText(body, nameOf).replace(/\s+/g, ' ').trim();
  const first = matchRuns(text, words).reduce<{ at: number; found: boolean }>(
    (acc, run) =>
      acc.found
        ? acc
        : run.hit
          ? { at: acc.at, found: true }
          : { at: acc.at + run.text.length, found: false },
    { at: 0, found: false },
  );
  let start = 0;
  if (first.found && first.at > SNIPPET_LEAD) {
    // Start on a word boundary inside the lead, so no word is cut in half.
    const space = text.indexOf(' ', first.at - SNIPPET_LEAD);
    start = space !== -1 && space < first.at ? space + 1 : first.at;
  }
  let out = text.slice(start, start + max);
  if (start + max < text.length) out = `${out.trimEnd()}${ELLIPSIS}`;
  return start > 0 ? `${ELLIPSIS}${out}` : out;
}

/** The weekday names the date label uses. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Whole calendar days from day a to day b (YYYY-MM-DD, no zone). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * A hit's date on the viewer's clock: today the time, yesterday "Yesterday",
 * the last 7 days the weekday, older DD/MM/YY. Pure (now is passed in;
 * `timeZone` is for tests, the app passes none).
 */
export function searchDateLabel(createdAt: string, nowMs: number, timeZone?: string): string {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return '';
  const day = civilDay(ts, timeZone);
  const today = civilDay(nowMs, timeZone);
  const ago = daysBetween(day, today);
  if (ago <= 0) return formatTime(ts, timeZone);
  if (ago === 1) return 'Yesterday';
  if (ago < 7) return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? '';
  const [y, m, d] = day.split('-');
  return `${d ?? ''}/${m ?? ''}/${(y ?? '').slice(-2)}`;
}

/**
 * The label before a hit's snippet: "You: " for my messages, "<First name>: "
 * for another sender in a group (from names already loaded), none in a DM. Pure.
 */
export function searchSenderPrefix(input: {
  senderUserId: string | null;
  currentUserId: string | null;
  isGroup: boolean;
  nameOf: PreviewNameOf;
}): string {
  if (input.currentUserId === null) return '';
  const prefix = previewPrefix({
    senderUserId: input.senderUserId,
    currentUserId: input.currentUserId,
    isGroup: input.isGroup,
    nameOf: input.nameOf,
  });
  return prefix !== undefined ? `${prefix}: ` : '';
}

/** "N of M", with "+" while more pages exist; "0 of 0" with no hits. Pure. */
export function searchCounterText(index: number, total: number, hasMore: boolean): string {
  if (total === 0) return '0 of 0';
  return `${Math.min(index + 1, total)} of ${total}${hasMore ? '+' : ''}`;
}

/**
 * The in-chat arrows over newest-first hits: older is the next index, newer
 * the previous. Null when there is no loaded hit that way (older may still
 * need the next page). Pure.
 */
export function stepSearchIndex(
  index: number,
  direction: 'older' | 'newer',
  total: number,
): number | null {
  const next = direction === 'older' ? index + 1 : index - 1;
  return next >= 0 && next < total ? next : null;
}
