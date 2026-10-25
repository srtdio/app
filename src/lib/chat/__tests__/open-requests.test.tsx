// @vitest-environment jsdom
// A chat open's requests, counted per table on a recording client: the latest
// page, then ONE reactions IN read and ONE quoted-rows IN read over the page's
// ids, and ONE cursors read (plus its one IN read of the cursor messages) that
// the DM seen ticks share. The counts are the same for a 10-row and a 50-row
// page: nothing is read per message. A reopen of a remembered page is constant
// the same way.
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

import { useChatThread, type UseChatThread } from '@/lib/chat/use-chat-thread';
import { createOpenCache, type OpenCache } from '@/lib/chat/open-cache';
import { rowCursor, rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import type { ChannelOutbox } from '@/lib/chat/chat-store';
import { clearMessagePrefetch } from '@/lib/chat/history';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const WS = 'ws-1';
const CHANNEL = 'dm__ws-1__a__b';

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

/** The page oldest first; the peer has read up to its middle row. */
function pageOf(size: number): ChatMessageRow[] {
  return Array.from({ length: size }, (_, i) => row(i));
}

/**
 * A recording PostgREST-ish client: every from() is one request; chained
 * methods log and return the query; awaiting answers from the page.
 */
function recordingClient(page: readonly ChatMessageRow[]): { db: Client; queries: Query[] } {
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
  const rpc = (fn: string): Promise<{ data: unknown; error: null }> => {
    queries.push({ table: `rpc:${fn}`, calls: [] });
    return Promise.resolve({ data: [], error: null });
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

function Probe(props: { db: Client; peerUserId: string | null; memory: OpenCache }): ReactElement {
  latest = useChatThread({
    client: null,
    status: 'connected',
    channelId: CHANNEL,
    target: null,
    currentUserId: ME,
    peerUserId: props.peerUserId,
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

async function open(
  size: number,
  opts: { peerUserId: string | null; remembered?: boolean },
): Promise<{ queries: Query[]; thread: UseChatThread | null }> {
  const page = pageOf(size);
  const { db, queries } = recordingClient(page);
  const memory = createOpenCache();
  if (opts.remembered === true) {
    const newest = page[page.length - 1];
    memory.remember({ userId: ME, workspaceId: WS, channelId: CHANNEL }, 'thread', {
      rows: page.map((r) => rowToThreadMessage({ ...r, reply_to_message_id: null }, ME)),
      hasMore: false,
      through: newest !== undefined ? rowCursor(newest) : undefined,
      reads: null,
      unresolved: [],
    });
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Probe db={db} peerUserId={opts.peerUserId} memory={memory} />);
  });
  await settle();
  return { queries, thread: latest };
}

beforeEach(() => {
  // Pinned so the page (2026-10-20) sits inside the first 30-day window.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  clearMessagePrefetch();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
});

describe('chat open: no request per message', () => {
  it('a DM open with a 50-message page reads a fixed set of batched requests', async () => {
    const { queries, thread } = await open(50, { peerUserId: PEER });
    expect(thread?.messages).toHaveLength(50);
    expect(perTable(queries)).toEqual({
      // The latest page, the quoted rows (one IN), the cursor messages (one IN).
      chat_messages: 3,
      // Every row's reactions in one IN read.
      chat_reactions: 1,
      // One cursors read: the seen ticks take the peer's from it.
      chat_read_cursors: 1,
    });
    const reactions = queries.find((q) => q.table === 'chat_reactions');
    expect((reactions !== undefined ? argsOf(reactions, 'in')?.[1] : []) as string[]).toHaveLength(
      50,
    );
    // No separate peer cursor select (maybeSingle on chat_read_cursors).
    expect(queries.some((q) => q.table === 'chat_read_cursors' && has(q, 'maybeSingle'))).toBe(
      false,
    );
    // The seen ticks still land: own rows up to the peer's cursor read as read.
    const mineRead = (thread?.messages ?? []).filter((m) => m.mine && m.status === 'read');
    expect(mineRead.length).toBeGreaterThan(0);
  });

  it('the counts do not grow with the page: 10 rows and 50 rows read the same', async () => {
    const small = perTable((await open(10, { peerUserId: PEER })).queries);
    act(() => root?.unmount());
    host?.remove();
    const large = perTable((await open(50, { peerUserId: PEER })).queries);
    expect(large).toEqual(small);
  });

  it('a group open (no peer) reads the same fixed set', async () => {
    const { queries } = await open(50, { peerUserId: null });
    expect(perTable(queries)).toEqual({
      chat_messages: 3,
      chat_reactions: 1,
      chat_read_cursors: 1,
    });
  });

  it('a reopen of a remembered 50-row page revalidates with a fixed set too', async () => {
    const small = perTable((await open(10, { peerUserId: PEER, remembered: true })).queries);
    act(() => root?.unmount());
    host?.remove();
    const { queries } = await open(50, { peerUserId: PEER, remembered: true });
    const large = perTable(queries);
    expect(large).toEqual(small);
    expect(large).toEqual({
      // The forward read, the remembered rows by id (one IN), the cursor messages (one IN).
      chat_messages: 3,
      chat_reactions: 1,
      chat_read_cursors: 1,
    });
  });
});
