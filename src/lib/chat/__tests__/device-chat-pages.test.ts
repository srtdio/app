// Device cache, part B: chat pages. A remembered page is saved through the
// session reads on every keep and live change (never empty, never an outbox
// row), at most OPEN_CACHE_LIMIT per workspace; a cold open seeds the open
// cache from the saved page the first time the chat is asked for, so the
// reopen path (remembered page first, revalidate from `through`) runs. The
// kill switch (sign-out, account switch, a workspace no longer listed)
// removes the chat keys with every other saved read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  OPEN_CACHE_LIMIT,
  chatPageKey,
  chatPagesKey,
  createOpenCache,
  forgetThreadsOutside,
  fromSavedPage,
  sessionPageDevice,
  toSavedPage,
  type ChatKey,
  type RememberedThread,
} from '@/lib/chat/open-cache';
import { openingState } from '@/lib/chat/use-chat-thread';
import { rowCursor, rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import {
  noteAuthUser,
  peekKept,
  primeRead,
  resetSessionReads,
  retainWorkspaceReads,
} from '@/lib/session-read';
import { isPersistable, setDeviceCacheBackend } from '@/lib/device-cache';

const ME = '11111111-1111-4111-8111-111111111111';
const A: ChatKey = { userId: ME, workspaceId: 'w1', channelId: 'c1' };

function row(key: ChatKey, i: number): ChatMessageRow {
  return {
    id: `m-${key.channelId}-${i}`,
    channel_id: key.channelId,
    workspace_id: key.workspaceId,
    sender_user_id: ME,
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
  } as ChatMessageRow;
}

function page(key: ChatKey, count: number): RememberedThread {
  const rows = Array.from({ length: count }, (_, i) => row(key, i));
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((r) => rowToThreadMessage(r, ME)),
    hasMore: false,
    through: last !== undefined ? rowCursor(last) : undefined,
    reads: { rows: [], times: new Map([['m-c1-0', 1]]) },
    unresolved: [],
  };
}

/** An in-memory stand-in for the session reads. */
function fakeIo(): {
  values: Map<string, unknown>;
  dropped: string[];
  io: Parameters<typeof sessionPageDevice>[0];
} {
  const values = new Map<string, unknown>();
  const dropped: string[] = [];
  return {
    values,
    dropped,
    io: {
      peek: (k) => values.get(k),
      prime: (k, v) => void values.set(k, v),
      drop: (k) => {
        dropped.push(k);
        values.delete(k);
      },
    },
  };
}

beforeEach(() => {
  // No IndexedDB here: the device side is a quiet no-op.
  setDeviceCacheBackend(null);
});

afterEach(() => {
  resetSessionReads();
});

describe('saving a page', () => {
  it('a keep saves the page under chat:page (plain data) and the order list', () => {
    const { values, io } = fakeIo();
    const store = createOpenCache({ device: sessionPageDevice(io) });
    const owner = store.attach(A);
    owner.keep(page(A, 3));
    owner.release();
    const saved = values.get(chatPageKey(A)) as { rows: unknown[]; reads: { times: unknown } };
    expect(saved.rows).toHaveLength(3);
    // The cursor times are pairs, not a Map, so the value is plain JSON.
    expect(saved.reads.times).toEqual([['m-c1-0', 1]]);
    expect(values.get(chatPagesKey(ME, 'w1'))).toEqual(['c1']);
    expect(chatPageKey(A)).toBe(`${ME}:w1:chat:page:c1`);
    expect(isPersistable(chatPageKey(A))).toBe(true);
  });

  it('never saves an empty page', () => {
    const { values, io } = fakeIo();
    const store = createOpenCache({ device: sessionPageDevice(io) });
    const owner = store.attach(A);
    owner.keep(page(A, 0));
    owner.release();
    expect(values.has(chatPageKey(A))).toBe(false);
    expect(toSavedPage(page(A, 0))).toBeNull();
  });

  it('never saves a sending or failed (outbox) row', () => {
    const p = page(A, 2);
    const first = p.rows[0];
    const second = p.rows[1];
    if (first === undefined || second === undefined) throw new Error('rows');
    const withOutbox: RememberedThread = {
      ...p,
      rows: [first, { ...second, id: 'out-1', state: 'sending' }, { ...second, state: 'failed' }],
    };
    const saved = toSavedPage(withOutbox);
    expect(saved?.rows.map((m) => m.id)).toEqual([first.id]);
    const onlyOutbox: RememberedThread = { ...p, rows: [{ ...first, state: 'sending' }] };
    expect(toSavedPage(onlyOutbox)).toBeNull();
  });

  it('a live change on a closed remembered chat saves the page again', () => {
    const { values, io } = fakeIo();
    const store = createOpenCache({ device: sessionPageDevice(io) });
    const owner = store.attach(A);
    owner.keep(page(A, 2));
    owner.release();
    store.revise(A, 'thread', (t) => ({ ...t, rows: page(A, 3).rows }));
    expect((values.get(chatPageKey(A)) as { rows: unknown[] }).rows).toHaveLength(3);
  });

  it('keeps at most OPEN_CACHE_LIMIT pages per workspace, least recently kept out first', () => {
    const { values, dropped, io } = fakeIo();
    const store = createOpenCache({ device: sessionPageDevice(io), limit: 100 });
    for (let i = 0; i <= OPEN_CACHE_LIMIT; i += 1) {
      const key = { ...A, channelId: `c${i}` };
      const owner = store.attach(key);
      owner.keep(page(key, 1));
      owner.release();
    }
    const order = values.get(chatPagesKey(ME, 'w1')) as string[];
    expect(order).toHaveLength(OPEN_CACHE_LIMIT);
    expect(order[0]).toBe('c1');
    expect(dropped).toEqual([chatPageKey({ ...A, channelId: 'c0' })]);
    // Another workspace has its own cap.
    const other = { ...A, workspaceId: 'w2' };
    const owner = store.attach(other);
    owner.keep(page(other, 1));
    owner.release();
    expect(values.get(chatPagesKey(ME, 'w2'))).toEqual(['c1']);
  });
});

describe('a cold open', () => {
  it('seeds the open cache from the saved page on the first open and paints it with no skeleton', () => {
    const { values, io } = fakeIo();
    values.set(chatPageKey(A), toSavedPage(page(A, 4)));
    const store = createOpenCache({ device: sessionPageDevice(io) });
    const seeded = store.recall(A, 'thread');
    expect(seeded?.rows).toHaveLength(4);
    // The reopen path: revalidate from the remembered page's contiguous end.
    expect(seeded?.through).toEqual(rowCursor(row(A, 3)));
    expect(seeded?.reads?.times).toBeInstanceOf(Map);
    const opening = openingState({
      channelId: A.channelId,
      page: seeded,
      outbox: [],
      currentUserId: ME,
    });
    expect(opening.loading).toBe(false);
    expect(opening.messages).toHaveLength(4);
  });

  it('a workspace switch clears the memory, and the device copy seeds the next open again', () => {
    const { values, io } = fakeIo();
    values.set(chatPageKey(A), toSavedPage(page(A, 2)));
    const store = createOpenCache({ device: sessionPageDevice(io) });
    expect(store.recall(A, 'thread')).toBeDefined();
    store.leaveScope({ userId: ME, workspaceId: 'w1' });
    expect(store.size()).toBe(0);
    // Another workspace's chat never sees w1's page.
    expect(store.recall({ ...A, workspaceId: 'w2' }, 'thread')).toBeUndefined();
    expect(store.recall(A, 'thread')?.rows).toHaveLength(2);
  });

  it('a forgotten page is never seeded back', () => {
    const { values, io } = fakeIo();
    values.set(chatPageKey(A), toSavedPage(page(A, 2)));
    values.set(chatPagesKey(ME, 'w1'), ['c1']);
    const store = createOpenCache({ device: sessionPageDevice(io) });
    store.forget(A, 'thread');
    expect(values.get(chatPageKey(A))).toBeNull();
    expect(values.get(chatPagesKey(ME, 'w1'))).toEqual([]);
    store.clear();
    expect(store.recall(A, 'thread')).toBeUndefined();
    expect(fromSavedPage(null)).toBeUndefined();
  });

  it('a roster that no longer lists a saved chat forgets its saved page', () => {
    const { values, io } = fakeIo();
    values.set(chatPageKey(A), toSavedPage(page(A, 2)));
    const store = createOpenCache({ device: sessionPageDevice(io) });
    forgetThreadsOutside(ME, 'w1', new Set(['c9']), () => false, store, ['c1']);
    expect(values.get(chatPageKey(A))).toBeNull();
  });
});

describe('the kill switch', () => {
  const listKey = `${ME}:w1:chat:list`;

  it('sign-out removes the chat keys', () => {
    primeRead(chatPageKey(A), toSavedPage(page(A, 1)));
    primeRead(listKey, { roster: [], conversations: {}, clears: {} });
    resetSessionReads();
    expect(peekKept(chatPageKey(A))).toBeUndefined();
    expect(peekKept(listKey)).toBeUndefined();
  });

  it('an account switch removes the chat keys', () => {
    noteAuthUser('SIGNED_IN', ME);
    primeRead(chatPageKey(A), toSavedPage(page(A, 1)));
    primeRead(listKey, { roster: [], conversations: {}, clears: {} });
    noteAuthUser('SIGNED_IN', 'someone-else');
    expect(peekKept(chatPageKey(A))).toBeUndefined();
    expect(peekKept(listKey)).toBeUndefined();
  });

  it('a workspace no longer listed drops its chat keys, and only its', () => {
    const B = { ...A, workspaceId: 'w2' };
    primeRead(chatPageKey(A), toSavedPage(page(A, 1)));
    primeRead(listKey, { roster: [], conversations: {}, clears: {} });
    primeRead(chatPageKey(B), toSavedPage(page(B, 1)));
    retainWorkspaceReads(ME, ['w2']);
    expect(peekKept(chatPageKey(A))).toBeUndefined();
    expect(peekKept(listKey)).toBeUndefined();
    expect(peekKept(chatPageKey(B))).toBeDefined();
  });
});
