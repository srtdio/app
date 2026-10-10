import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  canStar,
  createChannelStarsLoader,
  createStarStore,
  EMPTY_STARS,
  groupByChannel,
  isStarredIn,
  listRowStarred,
  loadChannelStars,
  loadStarredPage,
  mergeStarredRows,
  selectionStarAction,
  setStarsRecord,
  starredListArgs,
  starredNext,
  starredQuery,
  starredRowHead,
  STAR_BATCH_MAX,
  STARRED_PAGE_SIZE,
  toStarredRow,
  unstarLabel,
  type StarredRow,
} from '@/lib/chat/stars';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WS = '11111111-1111-4111-8111-111111111111';

type Write = Parameters<typeof createStarStore>[0]['write'];

function okWrite(): { write: NonNullable<Write>; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    write: async (params) => {
      calls.push({ ...params, messageIds: [...params.messageIds] });
      return { ok: true, data: null };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function row(id: string, createdAt: string, extra: Partial<StarredRow> = {}): StarredRow {
  return {
    id,
    channelId: 'c1',
    senderUserId: 'u1',
    body: id,
    createdAt,
    mediaLine: '',
    ...extra,
  };
}

describe('pure rules', () => {
  it('a star shows from this session first, else from the read', () => {
    const snap = {
      ...EMPTY_STARS,
      ids: new Set(['a']),
      local: new Map([
        ['b', true],
        ['a', false],
      ]),
    };
    expect(isStarredIn(snap, 'a')).toBe(false);
    expect(isStarredIn(snap, 'b')).toBe(true);
    expect(isStarredIn(snap, 'c')).toBe(false);
    expect(listRowStarred(snap, 'a')).toBe(false);
    expect(listRowStarred(snap, 'c')).toBe(true);
  });

  it('only recorded live messages take a star (no tombstone, pending or failed)', () => {
    expect(canStar({ state: 'sent' })).toBe(true);
    expect(canStar({ state: 'sent', deleted: true })).toBe(false);
    expect(canStar({ state: 'sending' })).toBe(false);
    expect(canStar({ state: 'failed' })).toBe(false);
  });

  it('selection: Unstar only when every selected one is starred, else Star', () => {
    const starred = new Set(['a', 'b']);
    const is = (id: string): boolean => starred.has(id);
    expect(selectionStarAction(['a', 'b'], is)).toBe('unstar');
    expect(selectionStarAction(['a', 'c'], is)).toBe('star');
    expect(selectionStarAction(['c'], is)).toBe('star');
    expect(selectionStarAction([], is)).toBeNull();
  });

  it('groups targets by channel and chunks at 100', () => {
    const many = Array.from({ length: STAR_BATCH_MAX + 1 }, (_, i) => ({
      id: `m${i}`,
      channelId: 'c1',
    }));
    const groups = groupByChannel([
      ...many,
      { id: 'x', channelId: 'c2' },
      { id: 'm0', channelId: 'c1' },
    ]);
    expect(groups.map((g) => [g.channelId, g.ids.length])).toEqual([
      ['c1', 100],
      ['c1', 1],
      ['c2', 1],
    ]);
  });

  it('1 character is ignored, 2+ narrows', () => {
    expect(starredQuery('a')).toBeNull();
    expect(starredQuery(' a ')).toBeNull();
    expect(starredQuery('ab')).toBe('ab');
    expect(starredQuery('  hero  ')).toBe('hero');
  });

  it('list paging: named args, keyset cursor, optional args left out', () => {
    expect(starredListArgs({ workspaceId: WS, traceId: 't' })).toEqual({
      p_workspace_id: WS,
      p_trace_id: 't',
      p_limit: STARRED_PAGE_SIZE,
    });
    expect(
      starredListArgs({
        workspaceId: WS,
        traceId: 't',
        channelId: 'c1',
        query: 'h',
        before: { createdAt: '2026-10-01T00:00:00Z', id: 'm9' },
      }),
    ).toEqual({
      p_workspace_id: WS,
      p_trace_id: 't',
      p_channel_id: 'c1',
      p_before_created_at: '2026-10-01T00:00:00Z',
      p_before_id: 'm9',
      p_limit: 30,
    });
    expect(starredListArgs({ workspaceId: WS, traceId: 't', query: 'hero' }).p_query).toBe('hero');
  });

  it('a full page carries the next cursor; a short one ends', () => {
    const rows = [row('b', '2026-10-02'), row('a', '2026-10-01')];
    expect(starredNext(rows, 2)).toEqual({ createdAt: '2026-10-01', id: 'a' });
    expect(starredNext(rows, 3)).toBeNull();
  });

  it('a re-read page merges in newest first, never shortening', () => {
    const loaded = [row('c', '2026-10-03'), row('a', '2026-10-01')];
    const merged = mergeStarredRows(loaded, [
      row('d', '2026-10-04'),
      row('c', '2026-10-03', { body: 'new' }),
    ]);
    expect(merged.map((r) => r.id)).toEqual(['d', 'c', 'a']);
    expect(merged[1]?.body).toBe('new');
  });

  it('row head: You for own, chat part only in the all-chats view and never for DMs', () => {
    const nameOf = (id: string): string | undefined => (id === 'u2' ? 'Chitra' : undefined);
    const base = { currentUserId: 'u1', nameOf, chatTitle: 'Diwali shoot', isDm: false };
    expect(starredRowHead({ ...base, senderUserId: 'u1', showChat: true })).toEqual({
      sender: 'You',
      chat: 'Diwali shoot',
    });
    expect(starredRowHead({ ...base, senderUserId: 'u2', showChat: false }).chat).toBeNull();
    expect(
      starredRowHead({ ...base, senderUserId: 'u2', showChat: true, isDm: true }).chat,
    ).toBeNull();
    expect(starredRowHead({ ...base, senderUserId: 'u3', showChat: true }).sender).toBe('Unknown');
  });

  it('edit bar label', () => {
    expect(unstarLabel(3)).toBe('Unstar (3)');
  });

  it('a media row reads the compact attachment summary', () => {
    const r = toStarredRow({
      id: 'm1',
      channel_id: 'c1',
      sender_user_id: 'u1',
      body: '',
      created_at: '2026-10-01T00:00:00Z',
      attachment_asset_ids: ['a1'],
      attachment_meta: [{ asset_id: 'a1', mime: 'image/jpeg', name: 'p.jpg', size: 10 }],
      agora_event_id: null,
      deleted_at: null,
      edited_at: null,
      forwarded_from_message_id: null,
      mentions: null,
      reply_to_message_id: null,
      shared_brief_ids: null,
      shared_plan_ids: null,
      shared_post_ids: null,
      thread_root_message_id: null,
      workspace_id: WS,
    });
    expect(r.mediaLine).not.toBe('');
  });
});

describe('star store', () => {
  it('toggle flips at once, writes once per channel with a fresh uuid_v7 trace', async () => {
    const { write, calls } = okWrite();
    const store = createStarStore({ workspaceId: WS, write });
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(isStarredIn(store.getSnapshot(), 'm1')));
    const done = store.toggle(
      [
        { id: 'm1', channelId: 'c1' },
        { id: 'm2', channelId: 'c1' },
        { id: 'm3', channelId: 'c2' },
      ],
      true,
    );
    // Flipped before the write answers.
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(true);
    expect(await done).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ channelId: 'c1', messageIds: ['m1', 'm2'], starred: true });
    expect(calls[1]).toMatchObject({ channelId: 'c2', messageIds: ['m3'], starred: true });
    for (const call of calls) expect(String(call.traceId)).toMatch(UUID_V7);
    expect(seen[0]).toBe(true);
    // An accepted star moves the version (lists re-read their first page).
    expect(store.getSnapshot().version).toBe(1);
  });

  it('a refused write reverts silently and reports the failure', async () => {
    const store = createStarStore({
      workspaceId: WS,
      write: async () => ({
        ok: false,
        error: { code: 'unknown', message: 'not a member of this chat' },
      }),
    });
    store.setChannel('c1', ['m1']);
    const result = await store.toggle([{ id: 'm1', channelId: 'c1' }], false);
    expect(result).toEqual({ ok: false, message: 'not a member of this chat' });
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(true);
    const star = await store.toggle([{ id: 'm2', channelId: 'c1' }], true);
    expect(star.ok).toBe(false);
    expect(isStarredIn(store.getSnapshot(), 'm2')).toBe(false);
    expect(store.getSnapshot().version).toBe(0);
  });

  it('a tombstone drops its star (bubble and lists)', () => {
    const store = createStarStore({ workspaceId: WS, write: okWrite().write });
    store.setChannel('c1', ['m1', 'm2']);
    store.drop(['m1', 'zz']);
    const snap = store.getSnapshot();
    expect(isStarredIn(snap, 'm1')).toBe(false);
    expect(listRowStarred(snap, 'm1')).toBe(false);
    expect(isStarredIn(snap, 'm2')).toBe(true);
    expect(snap.local.has('zz')).toBe(false);
  });

  it('a re-read gives settled changes the record value; one in flight waits', async () => {
    const gate = deferred<Result<null>>();
    const store = createStarStore({ workspaceId: WS, write: () => gate.promise });
    store.setChannel('c1', []);
    const pending = store.toggle([{ id: 'm1', channelId: 'c1' }], true);
    store.setChannel('c1', []);
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(true);
    gate.resolve({ ok: true, data: null });
    await pending;
    store.setChannel('c1', ['m1']);
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(true);
    store.setChannel('c1', []);
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(false);
    expect(listRowStarred(store.getSnapshot(), 'm1')).toBe(false);
  });

  it('one store per workspace: nothing carries across', () => {
    const a = createStarStore({ workspaceId: 'w1', write: okWrite().write });
    a.setChannel('c1', ['m1']);
    const b = createStarStore({ workspaceId: 'w2', write: okWrite().write });
    expect(isStarredIn(b.getSnapshot(), 'm1')).toBe(false);
    expect(b.workspaceId).toBe('w2');
  });
});

describe('first paint: stars land before the thread is told to paint', () => {
  it('the store holds the ids at the moment the channel settles', async () => {
    const store = createStarStore({ workspaceId: WS, write: okWrite().write });
    const atSettle: boolean[] = [];
    const loader = createChannelStarsLoader({
      store,
      read: async () => ({ ok: true, data: ['m1'] }),
      onSettled: () => atSettle.push(isStarredIn(store.getSnapshot(), 'm1')),
      current: () => 'c1',
    });
    await loader.load('c1');
    expect(atSettle).toEqual([true]);
  });

  it('a failed read still settles (no hold), a stale one is dropped', async () => {
    const store = createStarStore({ workspaceId: WS, write: okWrite().write });
    const settled: string[] = [];
    let open = 'c1';
    const first = deferred<Result<string[]>>();
    const loader = createChannelStarsLoader({
      store,
      read: (channelId) =>
        channelId === 'c1'
          ? first.promise
          : Promise.resolve({ ok: false, error: { code: 'unknown', message: 'x' } }),
      onSettled: (channelId) => settled.push(channelId),
      current: () => open,
    });
    const a = loader.load('c1');
    open = 'c2';
    await loader.load('c2');
    first.resolve({ ok: true, data: ['m1'] });
    await a;
    expect(settled).toEqual(['c2']);
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(false);
  });
});

describe('record calls', () => {
  it('chat_message_star_set: named args, trace id passed through', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = { rpc } as unknown as Parameters<typeof setStarsRecord>[0]['client'];
    const res = await setStarsRecord({
      client,
      channelId: 'c1',
      messageIds: ['m1'],
      starred: true,
      traceId: 't1',
    });
    expect(res.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('chat_message_star_set', {
      p_message_ids: ['m1'],
      p_channel_id: 'c1',
      p_starred: true,
      p_trace_id: 't1',
    });
  });

  it('chat_message_starred_list: one call, uuid_v7 trace, keyset next', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      id: `m${i}`,
      channel_id: 'c1',
      sender_user_id: 'u1',
      body: 'hi',
      created_at: `2026-10-0${2 - i}T00:00:00Z`,
    }));
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const client = { rpc } as unknown as Parameters<typeof loadStarredPage>[0]['client'];
    const res = await loadStarredPage({ client, workspaceId: WS, channelId: 'c1', limit: 2 });
    expect(res.ok && res.data.next).toEqual({ createdAt: '2026-10-01T00:00:00Z', id: 'm1' });
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(String(args.p_trace_id)).toMatch(UUID_V7);
    expect(args.p_channel_id).toBe('c1');
  });

  it('the channel read selects own message ids for one channel', async () => {
    const eq = vi.fn(async () => ({ data: [{ message_id: 'm1' }], error: null }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof loadChannelStars>[0];
    const res = await loadChannelStars(client, 'c1');
    expect(from).toHaveBeenCalledWith('chat_message_stars');
    expect(select).toHaveBeenCalledWith('message_id');
    expect(eq).toHaveBeenCalledWith('channel_id', 'c1');
    expect(res).toEqual({ ok: true, data: ['m1'] });
  });
});
