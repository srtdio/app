// @vitest-environment jsdom
// An empty chat page is never remembered. Leaving a chat whose thread recorded
// no server rows keeps nothing and forgets the thread memory, so the next open
// is fresh. A reopen of an empty remembered page whose revalidation read fails
// opens fresh (as a gap does) instead of staying empty for the tab session; a
// failed read on a page with rows keeps today's behaviour (the rows stay).
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
import { createOpenCache, type ChatKey, type OpenCache } from '@/lib/chat/open-cache';
import { rowCursor, rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import type { ChannelOutbox } from '@/lib/chat/chat-store';
import { clearMessagePrefetch } from '@/lib/chat/history';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

// Each test its own workspace and channel: shared reads never cross tests.
let seq = 0;
function keyOf(): ChatKey {
  seq += 1;
  return { userId: ME, workspaceId: `ws-empty-${seq}`, channelId: `dm__empty__${seq}` };
}

function row(key: ChatKey, i: number): ChatMessageRow {
  return {
    id: `m-${key.channelId}-${i}`,
    channel_id: key.channelId,
    workspace_id: key.workspaceId,
    sender_user_id: i % 2 === 0 ? ME : PEER,
    body: `message ${i}`,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    thread_root_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: `2026-10-20T10:00:${String(i).padStart(2, '0')}.000000+00:00`,
    edited_at: null,
    deleted_at: null,
    removed_files: {},
  };
}

function bundleOf(rows: readonly ChatMessageRow[]): Record<string, unknown> {
  return {
    server_now: '2026-10-25T12:00:00.000Z',
    messages: rows,
    has_more: false,
    quoted: [],
    reactions: [],
    read_cursors: [],
    cursor_messages: [],
    reply_counts: [],
    marks: [],
    scheduled: [],
    open_posts: [],
    open_post_count: 0,
    shared_plan_ids: [],
    open_briefs: [],
    open_brief_count: 0,
  };
}

/**
 * A client whose chat_open_bundle answers from `answers` in call order (the
 * last one repeats): rows, or 'fail' for an error. Table reads answer [].
 */
function client(answers: Array<readonly ChatMessageRow[] | 'fail'>): {
  db: Client;
  bundleCalls: () => number;
} {
  let calls = 0;
  const from = (): unknown => {
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
      builder[method] = () => builder;
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return builder;
  };
  const rpc = (fn: string): Promise<{ data: unknown; error: unknown }> => {
    if (fn !== 'chat_open_bundle') return Promise.resolve({ data: [], error: null });
    const answer = answers[Math.min(calls, answers.length - 1)] ?? 'fail';
    calls += 1;
    if (answer === 'fail') {
      return Promise.resolve({
        data: null,
        error: { code: 'unknown', message: 'Failed to fetch' },
      });
    }
    return Promise.resolve({ data: bundleOf(answer), error: null });
  };
  return { db: { from, rpc } as unknown as Client, bundleCalls: () => calls };
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
// Every render's loading flag, in order (the first is the opening frame).
let frames: boolean[] = [];

function Probe(props: { db: Client; chat: ChatKey; memory: OpenCache }): ReactElement {
  latest = useChatThread({
    client: null,
    status: 'connected',
    channelId: props.chat.channelId,
    target: null,
    currentUserId: ME,
    peerUserId: PEER,
    outbox: OUTBOX,
    db: props.db,
    workspaceId: props.chat.workspaceId,
    memory: props.memory,
  });
  frames.push(latest.loading);
  return <span />;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(db: Client, chat: ChatKey, memory: OpenCache): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Probe db={db} chat={chat} memory={memory} />);
  });
  await settle();
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

function remember(memory: OpenCache, chat: ChatKey, rows: readonly ChatMessageRow[]): void {
  const newest = rows[rows.length - 1];
  memory.remember(chat, 'thread', {
    rows: rows.map((r) => rowToThreadMessage(r, ME)),
    hasMore: false,
    through: newest !== undefined ? rowCursor(newest) : undefined,
    reads: null,
    unresolved: [],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  clearMessagePrefetch();
});

afterEach(() => {
  vi.useRealTimers();
  unmount();
  latest = null;
  frames = [];
});

describe('leaving a chat: an empty page is never remembered', () => {
  it('zero recorded rows: nothing is kept and the thread memory is forgotten', async () => {
    const chat = keyOf();
    const memory = createOpenCache();
    const forget = vi.spyOn(memory, 'forget');
    const { db } = client([[]]);
    await mount(db, chat, memory);
    expect(latest?.messages).toHaveLength(0);
    unmount();
    expect(memory.recall(chat, 'thread')).toBeUndefined();
    expect(forget).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: chat.channelId, workspaceId: chat.workspaceId }),
      'thread',
    );
  });

  it('the next open after an empty leave is fresh (loading, never a loaded empty page)', async () => {
    const chat = keyOf();
    const memory = createOpenCache();
    const { db } = client([[], [row(chat, 1), row(chat, 2)]]);
    await mount(db, chat, memory);
    unmount();
    frames = [];
    await mount(db, chat, memory);
    // No remembered page: the opening frame is a load, not an empty chat.
    expect(frames[0]).toBe(true);
  });

  it('rows recorded: the page is kept as today', async () => {
    const chat = keyOf();
    const memory = createOpenCache();
    const rows = [row(chat, 1), row(chat, 2), row(chat, 3)];
    const { db } = client([rows]);
    await mount(db, chat, memory);
    unmount();
    expect(memory.recall(chat, 'thread')?.rows.map((m) => m.id)).toEqual(rows.map((r) => r.id));
  });
});

describe('reopen: a failed revalidation read on an empty remembered page opens fresh', () => {
  it('zero rows and the read fails: the fresh open path runs and the page fills', async () => {
    const chat = keyOf();
    const memory = createOpenCache();
    remember(memory, chat, []);
    const rows = [row(chat, 1), row(chat, 2)];
    // The revalidation bundle fails; the fresh open's bundle lands.
    const { db, bundleCalls } = client(['fail', rows]);
    await mount(db, chat, memory);
    expect(bundleCalls()).toBe(2);
    expect(latest?.messages.map((m) => m.id)).toEqual(rows.map((r) => r.id));
  });

  it('rows remembered and the read fails: the remembered rows stay, no fresh open', async () => {
    const chat = keyOf();
    const memory = createOpenCache();
    const rows = [row(chat, 1), row(chat, 2), row(chat, 3)];
    remember(memory, chat, rows);
    const { db, bundleCalls } = client(['fail']);
    await mount(db, chat, memory);
    expect(bundleCalls()).toBe(1);
    expect(latest?.loading).toBe(false);
    expect(latest?.messages.map((m) => m.id)).toEqual(rows.map((r) => r.id));
  });
});
