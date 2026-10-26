// Workspace search for the command palette: the workspace_search_grouped and
// workspace_search_counts wrappers (called together, in parallel, under one
// uuid_v7 trace id per search) and the debounced runner that fires them with
// the existing chat_message_search caller (src/lib/chat/search.ts).
//
// Both RPCs are SECURITY INVOKER: RLS decides what comes back, so nothing here
// filters rows. grouped returns at most p_per_kind rows per kind (newest
// first); counts returns each kind's full match total for "Show all (N)".

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
import { chatMessageHref, chatTaskHref, planHref } from '@/lib/inbox/bell-types';
import { withSearchJump } from '@/lib/search/jump';
import { generateTraceId } from '@/lib/trace';

type GroupedFn = Database['public']['Functions']['workspace_search_grouped'];
type CountsFn = Database['public']['Functions']['workspace_search_counts'];
type GroupedArgs = GroupedFn['Args'];
type CountsArgs = CountsFn['Args'];
type GroupedRow = GroupedFn['Returns'][number];
type CountsRow = CountsFn['Returns'][number];

/** Rows per kind on a search, and on a group's "Show all". */
export const PER_KIND_PREVIEW = 5;
export const PER_KIND_FULL = 20;
/** Chat hits per search (chat_message_search; its group expands in place). */
export const CHAT_SEARCH_LIMIT = 20;

export const WORKSPACE_KINDS = [
  'person',
  'post',
  'brief',
  'comment',
  'file',
  'plan',
  'plan_item',
  'task',
  'chat_group',
] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

const KINDS = new Set<string>(WORKSPACE_KINDS);
function isKind(value: string): value is WorkspaceKind {
  return KINDS.has(value);
}

/** One workspace hit. A comment's parent is its post or brief; a plan item's its plan. */
export interface WorkspaceHit {
  kind: WorkspaceKind;
  id: string;
  parentId: string | null;
  channelId: string | null;
  entityType: string;
  number: number | null;
  title: string;
  snippet: string;
  actorUserId: string | null;
  actorIsMember: boolean;
  createdAt: string;
}

export type KindCounts = Partial<Record<WorkspaceKind, number>>;

export interface WorkspaceSearchData {
  hits: WorkspaceHit[];
  /** Null when counts were not asked for (a group's "Show all" refetch). */
  counts: KindCounts | null;
}

export type WorkspaceSearchResult =
  | { ok: true; data: WorkspaceSearchData }
  | { ok: false; error: string };

/** The named args of a grouped call; the query trimmed. Pure. */
export function groupedArgs(params: {
  workspaceId: string;
  query: string;
  traceId: string;
  perKind: number;
}): GroupedArgs {
  return {
    p_workspace_id: params.workspaceId,
    p_query: normalizeQuery(params.query),
    p_trace_id: params.traceId,
    p_per_kind: params.perKind,
  };
}

/** The named args of a counts call. Pure. */
export function countsArgs(params: {
  workspaceId: string;
  query: string;
  traceId: string;
}): CountsArgs {
  return {
    p_workspace_id: params.workspaceId,
    p_query: normalizeQuery(params.query),
    p_trace_id: params.traceId,
  };
}

/** A mention token cut off at the end of a snippet (never rendered). */
const CUT_TOKEN = /@\[[^\]]*$/;

/** A server row as a hit; null for a kind this client does not know. Pure. */
export function mapWorkspaceRow(row: GroupedRow): WorkspaceHit | null {
  if (!isKind(row.kind)) return null;
  const nullable = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v !== '' ? v : null;
  return {
    kind: row.kind,
    id: row.id,
    parentId: nullable(row.parent_id),
    channelId: nullable(row.channel_id),
    entityType: row.entity_type ?? '',
    number: typeof row.number === 'number' ? row.number : null,
    title: row.title ?? '',
    snippet: (row.snippet ?? '').replace(CUT_TOKEN, '').replace(/\s+/g, ' ').trim(),
    actorUserId: nullable(row.actor_user_id),
    actorIsMember: row.actor_is_member === true,
    createdAt: row.created_at,
  };
}

/** Counts rows as a per-kind map (unknown kinds dropped). Pure. */
export function mapCounts(rows: readonly CountsRow[]): KindCounts {
  const out: KindCounts = {};
  for (const row of rows) {
    if (isKind(row.kind) && typeof row.total === 'number') out[row.kind] = row.total;
  }
  return out;
}

/**
 * One search: workspace_search_grouped and (unless `counts` is false)
 * workspace_search_counts, in parallel, one round trip each, both carrying the
 * same trace id. Under 2 (or over 100) characters: no call, no rows. Never
 * throws; an abort, a timeout or either call failing is a failure.
 */
export async function searchWorkspace(params: {
  client: Client;
  workspaceId: string;
  query: string;
  signal: AbortSignal;
  perKind?: number;
  counts?: boolean;
  traceId?: string;
  timeoutMs?: number;
}): Promise<WorkspaceSearchResult> {
  const withCounts = params.counts !== false;
  if (!searchQueryReady(params.query)) {
    return { ok: true, data: { hits: [], counts: withCounts ? {} : null } };
  }
  const traceId = params.traceId ?? generateTraceId();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (params.signal.aborted) controller.abort();
  else params.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, params.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    const grouped = abortable(
      params.client.rpc(
        'workspace_search_grouped',
        groupedArgs({
          workspaceId: params.workspaceId,
          query: params.query,
          traceId,
          perKind: params.perKind ?? PER_KIND_PREVIEW,
        }),
      ),
      controller.signal,
    );
    const counts = withCounts
      ? abortable(
          params.client.rpc(
            'workspace_search_counts',
            countsArgs({ workspaceId: params.workspaceId, query: params.query, traceId }),
          ),
          controller.signal,
        )
      : null;
    const [g, c] = await Promise.all([grouped, counts]);
    if (controller.signal.aborted) return { ok: false, error: 'aborted' };
    if (g.error) return { ok: false, error: g.error.message };
    if (c !== null && c.error) return { ok: false, error: c.error.message };
    const rows = (g.data ?? []) as GroupedRow[];
    return {
      ok: true,
      data: {
        hits: rows.map(mapWorkspaceRow).filter((hit): hit is WorkspaceHit => hit !== null),
        counts: c !== null ? mapCounts((c.data ?? []) as CountsRow[]) : null,
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: String(error) };
  } finally {
    clearTimeout(timer);
    params.signal.removeEventListener('abort', abort);
  }
}

/** Where a hit opens: a path, or a person (their DM; me, my notes). */
export type HitTarget = { path: string } | { person: string };

function entityPath(type: string, id: string, n: number | null, key: string | null): string {
  const kind = type === 'brief' ? 'brief' : 'post';
  if (key !== null && n !== null) return entityUrlPath(kind, key, n);
  return `/${kind === 'post' ? 'posts' : 'briefs'}/${encodeURIComponent(id)}`;
}

/**
 * Where a hit opens, through the existing routes, carrying the searched words
 * (withSearchJump, the one jump mechanism): a post or brief its page; a
 * comment its parent at the comment (?comment=); a file the viewer (?asset=);
 * a plan its page; a plan item its plan, scrolled to the item (at=); a task its
 * chat's task sheet; a group its chat; a person their DM (no words). Pure.
 */
export function workspaceHitTarget(
  hit: WorkspaceHit,
  workspaceKey: string | null,
  query = '',
): HitTarget {
  const jump = (path: string, targetId: string | null = null): HitTarget => ({
    path: withSearchJump(path, query, targetId),
  });
  switch (hit.kind) {
    case 'post':
    case 'brief':
      return jump(entityPath(hit.kind, hit.id, hit.number, workspaceKey));
    case 'comment': {
      const parent = entityPath(hit.entityType, hit.parentId ?? '', hit.number, workspaceKey);
      return jump(`${parent}?comment=${encodeURIComponent(hit.id)}`);
    }
    case 'file':
      return jump(`/assets?asset=${encodeURIComponent(hit.id)}`);
    case 'plan':
      return jump(planHref(hit.id, null));
    case 'plan_item':
      return jump(planHref(hit.parentId ?? '', null), hit.id);
    case 'task':
      return jump(chatTaskHref(hit.channelId ?? '', hit.id));
    case 'chat_group':
      return jump(chatMessageHref(hit.channelId ?? '', null));
    case 'person':
      return { person: hit.id };
  }
}

/** A chat hit opens its chat at the message, with the searched words. Pure. */
export function chatHitPath(hit: Pick<SearchHit, 'channelId' | 'id'>, query = ''): string {
  return withSearchJump(chatMessageHref(hit.channelId, hit.id), query);
}

/** What the palette draws for a query. */
export interface PaletteSearchState {
  /** The trimmed query these results are for ('' when idle). */
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  workspace: WorkspaceHit[];
  counts: KindCounts;
  chat: SearchHit[];
  /** Kinds refetched at PER_KIND_FULL ("Show all" landed). */
  full: WorkspaceKind[];
}

export const IDLE_PALETTE_SEARCH: PaletteSearchState = {
  query: '',
  status: 'idle',
  workspace: [],
  counts: {},
  chat: [],
  full: [],
};

export interface PaletteSearchRunner {
  /** A keystroke: aborts the request in flight, debounces the next. */
  setQuery: (raw: string) => void;
  /** Run the failed query again, now. */
  retry: () => void;
  /** "Show all" on a workspace group: refetch at PER_KIND_FULL, expand in place. */
  expand: (kind: WorkspaceKind) => void;
  dispose: () => void;
}

/**
 * The palette's search state machine: from 2 characters, after the debounce,
 * the workspace search (grouped + counts) and the chat search go out together;
 * `prepare` (the batched name read) runs on their rows before the state turns
 * ready, so names never flash. A newer keystroke aborts everything and any
 * answer for an older query is dropped. Timers are injectable.
 */
export function createPaletteSearchRunner(options: {
  searchWorkspace: (
    query: string,
    signal: AbortSignal,
    full: boolean,
  ) => Promise<WorkspaceSearchResult>;
  searchChat: (query: string, signal: AbortSignal) => Promise<ChatSearchResult>;
  prepare?: (workspace: readonly WorkspaceHit[], chat: readonly SearchHit[]) => Promise<void>;
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
  const prepare = options.prepare ?? (() => Promise.resolve());
  let state: PaletteSearchState = IDLE_PALETTE_SEARCH;
  let generation = 0;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  const expanding = new Set<WorkspaceKind>();
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
    expanding.clear();
  };

  const run = (query: string, gen: number): void => {
    timer = null;
    const ctl = new AbortController();
    controller = ctl;
    void Promise.all([
      options.searchWorkspace(query, ctl.signal, false),
      options.searchChat(query, ctl.signal),
    ])
      .then(async ([ws, chat]) => {
        if (gen !== generation || disposed) return;
        if (!ws.ok || !chat.ok) {
          controller = null;
          emit({ ...IDLE_PALETTE_SEARCH, query, status: 'error' });
          return;
        }
        await prepare(ws.data.hits, chat.data.hits).catch(() => undefined);
        if (gen !== generation || disposed) return;
        controller = null;
        emit({
          query,
          status: 'ready',
          workspace: ws.data.hits,
          counts: ws.data.counts ?? {},
          chat: chat.data.hits,
          full: [],
        });
      })
      .catch(() => {
        if (gen !== generation || disposed) return;
        emit({ ...IDLE_PALETTE_SEARCH, query, status: 'error' });
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

  const expand = (kind: WorkspaceKind): void => {
    if (state.status !== 'ready' || state.full.includes(kind) || expanding.has(kind)) return;
    const gen = generation;
    const query = state.query;
    expanding.add(kind);
    const ctl = new AbortController();
    void options
      .searchWorkspace(query, ctl.signal, true)
      .then(async (res) => {
        if (gen !== generation || disposed) return;
        expanding.delete(kind);
        // A failed refetch keeps the 5 rows already shown.
        if (!res.ok) return;
        const rows = res.data.hits.filter((h) => h.kind === kind);
        await prepare(rows, []).catch(() => undefined);
        if (gen !== generation || disposed || state.status !== 'ready') return;
        emit({
          ...state,
          workspace: [...state.workspace.filter((h) => h.kind !== kind), ...rows],
          full: [...state.full, kind],
        });
      })
      .catch(() => {
        expanding.delete(kind);
      });
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
    expand,
    dispose: () => {
      generation += 1;
      stop();
      disposed = true;
    },
  };
}
