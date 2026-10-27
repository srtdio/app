// @vitest-environment jsdom
// The first tap on a pre-warmed chat. The pre-warm (prewarmChats) already ran
// the open's one chat_open_bundle call and kept its page; a tap within
// PREWARM_FRESH_MS takes that bundle as the open's own: no second bundle, no
// chat_messages id=in re-read, no chat_reactions re-read, and its marks,
// scheduled rows and cursors are this open's parts. The rows, tombstones,
// reactions, quotes and unread cursor are the ones a normal open shows, and
// a live event folded into the page after the pre-warm still shows. Later
// than PREWARM_FRESH_MS (or with a scheduled row due since) the tap reopens
// as before: the bundle from the page's end plus the two re-reads.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

import { prewarmChats, useChatThread, type UseChatThread } from '@/lib/chat/use-chat-thread';
import { createOpenCache, PREWARM_FRESH_MS, type OpenCache } from '@/lib/chat/open-cache';
import { joinChatBundle, openedFromPrewarm } from '@/lib/chat/open-bundle';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import type { ChannelOutbox } from '@/lib/chat/chat-store';
import { clearMessagePrefetch, readChatOpenBundle } from '@/lib/chat/history';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const WS = 'ws-1';
const CHANNEL = 'dm__ws-1__a__b';
const KEY = { userId: ME, workspaceId: WS, channelId: CHANNEL };

interface Query {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

/** The args of the first call to `method` on a query, or undefined. */
function argsOf(query: Query, method: string): unknown[] | undefined {
  return query.calls.find((c) => c.method === method)?.args;
}

function has(query: Query, method: string): boolean {
  return query.calls.some((c) => c.method === method);
}

function row(i: number, over: Partial<ChatMessageRow> = {}): ChatMessageRow {
  const second = String(i % 60).padStart(2, '0');
  const minute = String(Math.floor(i / 60)).padStart(2, '0');
  return {
    id: `m-${String(i).padStart(4, '0')}`,
    channel_id: CHANNEL,
    workspace_id: WS,
    sender_user_id: i % 2 === 0 ? ME : PEER,
    body: `message ${i}`,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    // Every fifth row quotes a message older than the page.
    reply_to_message_id: i % 5 === 0 ? `old-${i}` : null,
    thread_root_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: `2026-10-20T10:${minute}:${second}.000000+00:00`,
    edited_at: null,
    deleted_at: null,
    removed_files: {},
    ...over,
  };
}

/** The page oldest first; row 7 was deleted (a tombstone); the peer read up to the middle. */
function pageOf(size: number): ChatMessageRow[] {
  return Array.from({ length: size }, (_, i) =>
    i === 7 ? row(i, { body: null, deleted_at: '2026-10-20T11:00:00.000000+00:00' }) : row(i),
  );
}

/**
 * A recording PostgREST-ish client: every from() is one request; chained
 * methods log and return the query; awaiting answers from the page.
 */
function recordingClient(
  page: readonly ChatMessageRow[],
  scheduled: readonly Record<string, unknown>[] = [],
): { db: Client; queries: Query[] } {
  const queries: Query[] = [];
  const byId = new Map(page.map((r) => [r.id, r]));
  const peerRead = page[Math.floor(page.length / 2)] ?? page[0];
  const answer = (query: Query): { data: unknown; error: null } => {
    if (query.table === 'chat_messages') {
      const inArgs = argsOf(query, 'in');
      if (inArgs !== undefined) {
        const ids = inArgs[1] as string[];
        return {
          data: ids.map((id) => byId.get(id) ?? row(0, { id, created_at: '2026-10-01T00:00:00Z' })),
          error: null,
        };
      }
      // A forward read after the newest remembered row: nothing new.
      if (has(query, 'or')) return { data: [], error: null };
      // The paging floor probe (ORDER BY created_at ASC LIMIT 1): the oldest row.
      if (isFloorProbe(query)) return { data: page.slice(0, 1), error: null };
      // A partition-bounded window: the page's rows inside its created_at range.
      return { data: [...page].reverse().filter((r) => inRange(query, r.created_at)), error: null };
    }
    if (query.table === 'chat_reactions') {
      const ids = (argsOf(query, 'in')?.[1] ?? []) as string[];
      return {
        data: ids.map((id) => ({ message_id: id, emoji: '👍', user_id: PEER })),
        error: null,
      };
    }
    if (query.table === 'chat_read_cursors') {
      const cursor = (userId: string) => ({
        user_id: userId,
        last_read_message_id: peerRead?.id ?? 'none',
        last_read_at: peerRead?.created_at ?? '2026-10-20T10:00:00Z',
        read_at: peerRead?.created_at ?? null,
      });
      if (has(query, 'maybeSingle')) return { data: cursor(PEER), error: null };
      return { data: [cursor(ME), cursor(PEER)], error: null };
    }
    return { data: [], error: null };
  };
  const from = (table: string): unknown => {
    const query: Query = { table, calls: [] };
    queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const method of [
      'select',
      'eq',
      'is',
      'in',
      'or',
      'gt',
      'gte',
      'lt',
      'lte',
      'order',
      'limit',
      'abortSignal',
      'maybeSingle',
    ]) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(answer(query)).then(resolve, reject);
    return builder;
  };
  const cursorJson = (userId: string): Record<string, unknown> => ({
    user_id: userId,
    last_read_message_id: peerRead?.id ?? 'none',
    last_read_at: peerRead?.created_at ?? '2026-10-20T10:00:00Z',
    read_at: peerRead?.created_at ?? null,
  });
  // chat_open_bundle over the page: p_since inclusive, else the latest 50.
  const bundle = (args: Record<string, unknown>): Record<string, unknown> => {
    const since = typeof args.p_since === 'string' ? Date.parse(args.p_since) : null;
    const rows =
      since === null ? page.slice(-50) : page.filter((r) => Date.parse(r.created_at) >= since);
    const ids = new Set(rows.map((r) => r.id));
    const quoted = [
      ...new Set(
        rows.flatMap((r) => (r.reply_to_message_id !== null ? [r.reply_to_message_id] : [])),
      ),
    ]
      .filter((id) => !ids.has(id))
      .map((id) => row(0, { id, created_at: '2026-10-01T00:00:00Z' }));
    return {
      server_now: '2026-10-25T12:00:00.000Z',
      messages: rows,
      has_more: false,
      quoted,
      reactions: rows.map((r) => ({ message_id: r.id, emoji: '👍', user_id: PEER })),
      read_cursors: [cursorJson(ME), cursorJson(PEER)],
      cursor_messages:
        peerRead !== undefined ? [{ id: peerRead.id, created_at: peerRead.created_at }] : [],
      reply_counts: [],
      marks: [],
      scheduled,
      open_posts: [],
      open_post_count: 0,
      shared_plan_ids: [],
      open_briefs: [],
      open_brief_count: 0,
    };
  };
  const rpc = (
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: null }> => {
    queries.push({ table: `rpc:${fn}`, calls: [{ method: 'rpc', args: [args] }] });
    return Promise.resolve({ data: fn === 'chat_open_bundle' ? bundle(args) : [], error: null });
  };
  return { db: { from, rpc } as unknown as Client, queries };
}

/** The channel's paging floor probe: read once per channel when a window comes back short. */
function isFloorProbe(query: Query): boolean {
  const order = argsOf(query, 'order');
  return (
    query.table === 'chat_messages' &&
    order?.[0] === 'created_at' &&
    (order[1] as { ascending?: boolean } | undefined)?.ascending === true &&
    argsOf(query, 'limit')?.[0] === 1
  );
}

/** Whether `at` lies inside a query's created_at gte / lt / lte bounds. */
function inRange(query: Query, at: string): boolean {
  const t = Date.parse(at);
  return query.calls.every(({ method, args }) => {
    if (args[0] !== 'created_at') return true;
    const bound = Date.parse(String(args[1]));
    if (method === 'gte') return t >= bound;
    if (method === 'gt') return t > bound;
    if (method === 'lt') return t < bound;
    if (method === 'lte') return t <= bound;
    return true;
  });
}

/**
 * Requests per table. The paging floor probe is left out: it is one cached
 * read per channel (not per message), made only when a page is short.
 */
function perTable(queries: readonly Query[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const q of queries) {
    if (isFloorProbe(q)) continue;
    counts[q.table] = (counts[q.table] ?? 0) + 1;
  }
  return counts;
}

const OUTBOX: ChannelOutbox = {
  entries: () => [],
  enqueue: () => {},
  retry: () => {},
  settle: () => {},
  cancel: () => false,
  subscribe: () => () => {},
  messagesDeleted: () => {},
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: UseChatThread | null = null;

function Probe(props: { db: Client; memory: OpenCache }): ReactElement {
  latest = useChatThread({
    client: null,
    status: 'connected',
    channelId: CHANNEL,
    target: null,
    currentUserId: ME,
    peerUserId: PEER,
    outbox: OUTBOX,
    db: props.db,
    workspaceId: WS,
    memory: props.memory,
  });
  return <span />;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(db: Client, memory: OpenCache): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Probe db={db} memory={memory} />);
  });
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
}

/** The pre-warm over the recording client, as ChatConnected runs it. */
async function prewarm(db: Client, memory: OpenCache): Promise<number> {
  return prewarmChats([KEY], {
    store: memory,
    read: (key) =>
      readChatOpenBundle(db, {
        traceId: 'trace-prewarm',
        workspaceId: key.workspaceId,
        channelId: key.channelId,
        since: null,
      }),
    saveData: () => false,
    current: () => true,
  });
}

/** What a reader sees of each row (ids, tombstones, bodies, reactions, quotes). */
function shown(thread: UseChatThread | null): unknown[] {
  return (thread?.messages ?? []).map((m) => ({
    id: m.id,
    deleted: m.deleted === true,
    body: m.body,
    reactions: m.reactions,
    reply: m.reply?.preview ?? null,
  }));
}

/** A normal cold open of the same page (no memory, no pre-warm). */
async function coldOpen(page: readonly ChatMessageRow[]): Promise<{
  rows: unknown[];
  open: unknown;
  status: string | undefined;
}> {
  const { db } = recordingClient(page);
  mount(db, createOpenCache());
  await settle();
  const out = {
    rows: shown(latest),
    open: latest?.readState.open,
    status: latest?.readState.status,
  };
  unmount();
  return out;
}

const FUTURE_SCHEDULED = {
  id: 's-1',
  channel_id: CHANNEL,
  workspace_id: WS,
  sender_user_id: ME,
  body: 'later',
  mentions: null,
  attachment_asset_ids: null,
  attachment_meta: null,
  shared_post_ids: null,
  shared_brief_ids: null,
  reply_to_message_id: null,
  send_at: '2026-10-25T18:00:00.000Z',
  sent_at: null,
  status: 'pending',
  failure_reason: null,
  created_at: '2026-10-25T11:00:00.000Z',
  updated_at: '2026-10-25T11:00:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  clearMessagePrefetch();
});

afterEach(() => {
  vi.useRealTimers();
  unmount();
});

describe('first tap on a pre-warmed chat', () => {
  it('within 60 s: no bundle, chat_messages or chat_reactions read at the tap', async () => {
    const page = pageOf(30);
    const { db, queries } = recordingClient(page);
    const memory = createOpenCache();
    expect(await prewarm(db, memory)).toBe(1);
    expect(perTable(queries)).toEqual({ 'rpc:chat_open_bundle': 1 });
    vi.setSystemTime(new Date(Date.now() + PREWARM_FRESH_MS - 1_000));
    const before = queries.length;
    // The tap's kickoff, then the thread mounts and joins it.
    void joinChatBundle(KEY, {
      deps: {
        store: memory,
        read: (input, signal) => readChatOpenBundle(db, input, signal),
        share: (_u, _w, _what, load) => load(),
        traceId: () => 'trace-tap',
      },
    });
    mount(db, memory);
    await settle();
    expect(queries.slice(before)).toEqual([]);
    expect(perTable(queries)).toEqual({ 'rpc:chat_open_bundle': 1 });
    expect(latest?.messages).toHaveLength(30);
  });

  it('shows what a normal open shows: tombstones, quotes, the unread cursor', async () => {
    const page = pageOf(30);
    const cold = await coldOpen(page);
    const { db } = recordingClient(page);
    const memory = createOpenCache();
    await prewarm(db, memory);
    vi.setSystemTime(new Date(Date.now() + 10_000));
    mount(db, memory);
    await settle();
    expect(openedFromPrewarm(KEY, memory)).toBe(true);
    expect(shown(latest)).toEqual(cold.rows);
    const tomb = latest?.messages.find((m) => m.id === 'm-0007');
    expect(tomb?.deleted).toBe(true);
    expect(latest?.readState.status).toBe(cold.status);
    expect(latest?.readState.open).toEqual(cold.open);
  });

  it("its scheduled rows, marks and cursors are this open's parts (nothing re-read)", async () => {
    const page = pageOf(10);
    const { db, queries } = recordingClient(page, [FUTURE_SCHEDULED]);
    const memory = createOpenCache();
    await prewarm(db, memory);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    mount(db, memory);
    await settle();
    const scheduled = await memory.join(KEY, 'scheduled');
    expect(scheduled?.ok === true ? scheduled.data.map((r) => r.id) : null).toEqual(['s-1']);
    const marks = await memory.join(KEY, 'marks');
    expect(marks?.ok).toBe(true);
    expect(perTable(queries)).toEqual({ 'rpc:chat_open_bundle': 1 });
  });

  it('a live event folded in after the pre-warm still shows on the tap', async () => {
    const page = pageOf(10);
    const { db } = recordingClient(page);
    const memory = createOpenCache();
    await prewarm(db, memory);
    // A live delete for the closed chat (routeRememberedCmd lands it so).
    memory.revise(KEY, 'thread', (thread) => ({
      ...thread,
      rows: thread.rows.map((m) =>
        m.id === 'm-0003'
          ? rowToThreadMessage(
              row(3, { body: null, deleted_at: '2026-10-25T12:00:01.000000+00:00' }),
              ME,
            )
          : m,
      ),
    }));
    mount(db, memory);
    await settle();
    expect(latest?.messages.find((m) => m.id === 'm-0003')?.deleted).toBe(true);
  });

  it("after 60 s: today's reopen (bundle from the page end, rows by id, reactions)", async () => {
    const page = pageOf(30);
    const { db, queries } = recordingClient(page);
    const memory = createOpenCache();
    await prewarm(db, memory);
    vi.setSystemTime(new Date(Date.now() + PREWARM_FRESH_MS + 1_000));
    mount(db, memory);
    await settle();
    expect(openedFromPrewarm(KEY, memory)).toBe(false);
    expect(perTable(queries)).toEqual({
      'rpc:chat_open_bundle': 2,
      chat_messages: 1,
      chat_reactions: 1,
    });
    const tap = queries.filter((q) => q.table === 'rpc:chat_open_bundle')[1];
    const args = tap?.calls[0]?.args[0] as Record<string, unknown> | undefined;
    expect(args?.p_since).toBe(page[29]?.created_at);
  });

  it('a scheduled row due since the pre-warm: the tap reads as before', async () => {
    const page = pageOf(10);
    const due = { ...FUTURE_SCHEDULED, send_at: '2026-10-25T12:00:20.000Z' };
    const { db, queries } = recordingClient(page, [due]);
    const memory = createOpenCache();
    await prewarm(db, memory);
    vi.setSystemTime(new Date('2026-10-25T12:00:30.000Z'));
    mount(db, memory);
    await settle();
    expect(openedFromPrewarm(KEY, memory)).toBe(false);
    expect(perTable(queries)['rpc:chat_open_bundle']).toBe(2);
  });

  it('the pre-warm is spent by the first open: a second open reads as before', async () => {
    const page = pageOf(10);
    const { db, queries } = recordingClient(page);
    const memory = createOpenCache();
    await prewarm(db, memory);
    mount(db, memory);
    await settle();
    unmount();
    vi.setSystemTime(new Date(Date.now() + 5_000));
    mount(db, memory);
    await settle();
    expect(perTable(queries)).toEqual({
      'rpc:chat_open_bundle': 2,
      chat_messages: 1,
      chat_reactions: 1,
    });
  });
});
