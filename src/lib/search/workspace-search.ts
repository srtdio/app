// Workspace search for the command palette: the workspace_search wrapper
// (posts, briefs, comments) and the debounced runner that fires it in parallel
// with the existing chat_message_search caller (src/lib/chat/search.ts).
//
// workspace_search is SECURITY INVOKER: RLS decides what comes back (clients
// never see drafts), so nothing here filters rows. It is called with NAMED
// args and a fresh uuid_v7 p_trace_id per call; the server returns newest
// first, at most p_limit rows across all kinds.

import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import {
  normalizeQuery,
  searchQueryReady,
  SEARCH_DEBOUNCE_MS,
  type SearchHit,
  type SearchResult as ChatSearchResult,
} from '@/lib/chat/search';
import { entityUrlPath } from '@/lib/entityRef';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { generateTraceId } from '@/lib/trace';

type WorkspaceSearchFn = Database['public']['Functions']['workspace_search'];
export type WorkspaceSearchArgs = WorkspaceSearchFn['Args'];
type WorkspaceSearchRow = WorkspaceSearchFn['Returns'][number];

/** Rows per call (and per expanded group). */
export const WORKSPACE_SEARCH_LIMIT = 20;

export type WorkspaceHitKind = 'post' | 'brief' | 'comment';

/** One post, brief or comment hit. A comment's entity is its parent post or brief. */
export interface WorkspaceHit {
  kind: WorkspaceHitKind;
  id: string;
  entityType: 'post' | 'brief';
  entityId: string;
  entityNumber: number | null;
  title: string;
  snippet: string;
  createdAt: string;
}

export type WorkspaceSearchResult =
  | { ok: true; data: WorkspaceHit[] }
  | { ok: false; error: string };

/** The named args of one call; the query trimmed. Pure. */
export function workspaceSearchArgs(params: {
  workspaceId: string;
  query: string;
  traceId: string;
}): WorkspaceSearchArgs {
  return {
    p_workspace_id: params.workspaceId,
    p_query: normalizeQuery(params.query),
    p_trace_id: params.traceId,
    p_limit: WORKSPACE_SEARCH_LIMIT,
  };
}

function isKind(value: string): value is WorkspaceHitKind {
  return value === 'post' || value === 'brief' || value === 'comment';
}

/** A server row as a hit; null for a kind or parent this client does not know. Pure. */
export function mapWorkspaceRow(row: WorkspaceSearchRow): WorkspaceHit | null {
  if (!isKind(row.kind)) return null;
  if (row.entity_type !== 'post' && row.entity_type !== 'brief') return null;
  return {
    kind: row.kind,
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityNumber: typeof row.entity_number === 'number' ? row.entity_number : null,
    title: row.title ?? '',
    snippet: (row.snippet ?? '').replace(/\s+/g, ' ').trim(),
    createdAt: row.created_at,
  };
}

/**
 * One workspace_search call. Under 2 (or over 100) characters: no call, no
 * rows. Never throws; an abort or timeout is a failure.
 */
export async function searchWorkspace(params: {
  client: Client;
  workspaceId: string;
  query: string;
  signal: AbortSignal;
  traceId?: string;
  timeoutMs?: number;
}): Promise<WorkspaceSearchResult> {
  if (!searchQueryReady(params.query)) return { ok: true, data: [] };
  const args = workspaceSearchArgs({
    workspaceId: params.workspaceId,
    query: params.query,
    traceId: params.traceId ?? generateTraceId(),
  });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (params.signal.aborted) controller.abort();
  else params.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, params.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    const res = await abortable(params.client.rpc('workspace_search', args), controller.signal);
    if (controller.signal.aborted) return { ok: false, error: 'aborted' };
    if (res.error) return { ok: false, error: res.error.message };
    const rows = (res.data ?? []) as WorkspaceSearchRow[];
    return {
      ok: true,
      data: rows.map(mapWorkspaceRow).filter((hit): hit is WorkspaceHit => hit !== null),
    };
  } catch (error: unknown) {
    return { ok: false, error: String(error) };
  } finally {
    clearTimeout(timer);
    params.signal.removeEventListener('abort', abort);
  }
}

/**
 * Where a hit opens: a post or brief its short link; a comment its parent's
 * page. Without the workspace key yet, the id routes. Pure.
 */
export function workspaceHitPath(hit: WorkspaceHit, workspaceKey: string | null): string {
  if (workspaceKey !== null && hit.entityNumber !== null) {
    return entityUrlPath(hit.entityType, workspaceKey, hit.entityNumber);
  }
  return hit.entityType === 'post' ? `/posts/${hit.entityId}` : `/briefs/${hit.entityId}`;
}

/** A chat hit opens its chat at the message (the chat search's deep link). Pure. */
export function chatHitPath(hit: Pick<SearchHit, 'channelId' | 'id'>): string {
  return chatMessageHref(hit.channelId, hit.id);
}

/** What the palette draws for a query. */
export interface PaletteSearchState {
  /** The trimmed query these results are for ('' when idle). */
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  workspace: WorkspaceHit[];
  chat: SearchHit[];
}

export const IDLE_PALETTE_SEARCH: PaletteSearchState = {
  query: '',
  status: 'idle',
  workspace: [],
  chat: [],
};

export interface PaletteSearchRunner {
  /** A keystroke: aborts the request in flight, debounces the next. */
  setQuery: (raw: string) => void;
  /** Run the failed query again, now. */
  retry: () => void;
  dispose: () => void;
}

/**
 * The palette's search state machine: from 2 characters, after the debounce,
 * one workspace_search and one chat search go out together. A newer
 * keystroke aborts both and any answer for an older query is dropped. Either
 * call failing is an error (retry runs both again). Timers are injectable.
 */
export function createPaletteSearchRunner(options: {
  searchWorkspace: (query: string, signal: AbortSignal) => Promise<WorkspaceSearchResult>;
  searchChat: (query: string, signal: AbortSignal) => Promise<ChatSearchResult>;
  onChange: (state: PaletteSearchState) => void;
  debounceMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): PaletteSearchRunner {
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let state: PaletteSearchState = IDLE_PALETTE_SEARCH;
  let generation = 0;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let disposed = false;

  const emit = (next: PaletteSearchState): void => {
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
    void Promise.all([
      options.searchWorkspace(query, ctl.signal),
      options.searchChat(query, ctl.signal),
    ]).then(([ws, chat]) => {
      if (gen !== generation || disposed) return;
      controller = null;
      if (!ws.ok || !chat.ok) {
        emit({ ...IDLE_PALETTE_SEARCH, query, status: 'error' });
        return;
      }
      emit({ query, status: 'ready', workspace: ws.data, chat: chat.data.hits });
    });
  };

  const start = (query: string): void => {
    generation += 1;
    stop();
    if (!searchQueryReady(query)) {
      emit(IDLE_PALETTE_SEARCH);
      return;
    }
    const gen = generation;
    emit({ ...IDLE_PALETTE_SEARCH, query, status: 'loading' });
    timer = setTimer(() => run(query, gen), debounceMs);
  };

  return {
    setQuery: (raw) => {
      const query = normalizeQuery(raw);
      if (query === state.query && (state.status === 'loading' || state.status === 'ready')) {
        return;
      }
      start(query);
    },
    retry: () => {
      if (state.status !== 'error') return;
      const query = state.query;
      generation += 1;
      stop();
      const gen = generation;
      emit({ ...IDLE_PALETTE_SEARCH, query, status: 'loading' });
      run(query, gen);
    },
    dispose: () => {
      generation += 1;
      stop();
      disposed = true;
    },
  };
}
