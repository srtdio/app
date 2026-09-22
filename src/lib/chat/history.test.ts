import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  aggregateReactions,
  CATCH_UP_LIMIT,
  HISTORY_PAGE_SIZE,
  latestPerChannel,
  loadLatestMessages,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
  loadUnreadCounts,
  newerThanFilter,
  olderThanFilter,
} from '@/lib/chat/history';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';

interface Call {
  method: string;
  args: unknown[];
}

// A recording PostgREST-ish builder: every chained query method returns self and
// logs its call; awaiting yields the configured result. Mirrors chat-reads.test.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'or', 'order', 'limit', 'maybeSingle']) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return b;
  });
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ method: 'rpc', args: [fn, args] });
    return Promise.resolve(result);
  });
  return { client: { from, rpc } as unknown as Client, calls };
}

function methods(calls: Call[]): string[] {
  return calls.map((c) => c.method);
}

function argsOf(calls: Call[], method: string): unknown[][] {
  return calls.filter((c) => c.method === method).map((c) => c.args);
}

const CURSOR = { createdAt: '2026-09-22T10:00:00.123456+00:00', id: 'm-oldest' };

describe('keyset filters', () => {
  it('builds the compound (created_at, id) or-filter for older rows', () => {
    expect(olderThanFilter(CURSOR)).toBe(
      'created_at.lt."2026-09-22T10:00:00.123456+00:00",and(created_at.eq."2026-09-22T10:00:00.123456+00:00",id.lt."m-oldest")',
    );
  });

  it('builds the mirror filter for newer rows (catch-up)', () => {
    expect(newerThanFilter(CURSOR)).toBe(
      'created_at.gt."2026-09-22T10:00:00.123456+00:00",and(created_at.eq."2026-09-22T10:00:00.123456+00:00",id.gt."m-oldest")',
    );
  });
});

describe('loadLatestMessages', () => {
  it('reads the newest page from chat_messages (not Agora) and returns it oldest-first', async () => {
    const rows = [
      { id: 'b', created_at: '2026-09-22T10:00:02+00:00' },
      { id: 'a', created_at: '2026-09-22T10:00:01+00:00' },
    ];
    const { client, calls } = makeClient({ data: rows, error: null });

    const page = await loadLatestMessages(client, CHANNEL);

    expect(argsOf(calls, 'from')).toEqual([['chat_messages']]);
    expect(argsOf(calls, 'eq')).toEqual([['channel_id', CHANNEL]]);
    expect(argsOf(calls, 'is')).toEqual([['deleted_at', null]]);
    expect(argsOf(calls, 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(argsOf(calls, 'limit')).toEqual([[HISTORY_PAGE_SIZE]]);
    expect(methods(calls)).not.toContain('or');
    expect(page.ok && page.data.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.ok && page.data.hasMore).toBe(false);
  });

  it('reports hasMore on a full page and surfaces a query error as a Result', async () => {
    const full = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => ({ id: `m${i}` }));
    const ok = await loadLatestMessages(makeClient({ data: full, error: null }).client, CHANNEL);
    expect(ok.ok && ok.data.hasMore).toBe(true);

    const bad = await loadLatestMessages(
      makeClient({ data: null, error: { message: 'boom' } }).client,
      CHANNEL,
    );
    expect(bad.ok).toBe(false);
  });
});

describe('loadOlderMessages', () => {
  it('applies the keyset or-filter from the oldest loaded (created_at, id)', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await loadOlderMessages(client, CHANNEL, CURSOR);
    expect(argsOf(calls, 'or')).toEqual([[olderThanFilter(CURSOR)]]);
    expect(argsOf(calls, 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(argsOf(calls, 'limit')).toEqual([[HISTORY_PAGE_SIZE]]);
  });
});

describe('loadNewerMessages', () => {
  it('catches up from the newest loaded (created_at, id), ascending', async () => {
    const { client, calls } = makeClient({ data: [{ id: 'n1' }], error: null });
    const result = await loadNewerMessages(client, CHANNEL, CURSOR);
    expect(argsOf(calls, 'or')).toEqual([[newerThanFilter(CURSOR)]]);
    expect(argsOf(calls, 'order')).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    expect(argsOf(calls, 'limit')).toEqual([[CATCH_UP_LIMIT]]);
    expect(result.ok && result.data.map((r) => r.id)).toEqual(['n1']);
  });
});

describe('reactions', () => {
  it('aggregates rows per message and emoji with count + mine', () => {
    const map = aggregateReactions(
      [
        { message_id: 'm1', emoji: '👍', user_id: ME },
        { message_id: 'm1', emoji: '👍', user_id: 'other' },
        { message_id: 'm1', emoji: '❤️', user_id: 'other' },
        { message_id: 'm2', emoji: '🙏', user_id: 'other' },
      ],
      ME,
    );
    expect(map.get('m1')).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
    expect(map.get('m2')).toEqual([{ emoji: '🙏', count: 1, mine: false }]);
  });

  it('loads reactions with ONE in-query over the page ids and none for an empty page', async () => {
    const { client, calls } = makeClient({
      data: [{ message_id: 'm1', emoji: '👍', user_id: ME }],
      error: null,
    });
    const result = await loadReactions(client, ['m1', 'm2'], ME);
    expect(argsOf(calls, 'from')).toEqual([['chat_reactions']]);
    expect(argsOf(calls, 'in')).toEqual([['message_id', ['m1', 'm2']]]);
    expect(result.ok && result.data.get('m1')).toEqual([{ emoji: '👍', count: 1, mine: true }]);

    const empty = makeClient({ data: [], error: null });
    await loadReactions(empty.client, [], ME);
    expect(empty.calls).toHaveLength(0);
  });
});

describe('loadPeerReadCursor', () => {
  it('reads the peer row for the channel and reports found / not found', async () => {
    const { client, calls } = makeClient({
      data: { last_read_message_id: 'm9', last_read_at: '2026-09-22T11:00:00+00:00' },
      error: null,
    });
    const found = await loadPeerReadCursor(client, CHANNEL, 'peer');
    expect(argsOf(calls, 'from')).toEqual([['chat_read_cursors']]);
    expect(argsOf(calls, 'eq')).toEqual([
      ['channel_id', CHANNEL],
      ['user_id', 'peer'],
    ]);
    expect(found.ok && found.data).toEqual({
      found: true,
      lastReadMessageId: 'm9',
      lastReadAt: '2026-09-22T11:00:00+00:00',
    });

    const none = await loadPeerReadCursor(
      makeClient({ data: null, error: null }).client,
      CHANNEL,
      'p',
    );
    expect(none.ok && none.data).toEqual({ found: false });
  });
});

describe('loadUnreadCounts', () => {
  it('calls the chat_unread_counts proc with the workspace id and maps its rows', async () => {
    const { client, calls } = makeClient({
      data: [{ channel_id: CHANNEL, unread: 3, last_message_at: '2026-09-22T10:00:00+00:00' }],
      error: null,
    });
    const result = await loadUnreadCounts(client, 'ws-1');
    expect(argsOf(calls, 'rpc')).toEqual([['chat_unread_counts', { p_workspace_id: 'ws-1' }]]);
    expect(result.ok && result.data).toEqual([
      { channelId: CHANNEL, unread: 3, lastMessageAt: '2026-09-22T10:00:00+00:00' },
    ]);
  });
});

describe('latestPerChannel', () => {
  it('keeps the first (newest) row per channel from a newest-first scan', () => {
    const previews = latestPerChannel([
      {
        id: '3',
        channel_id: 'a',
        sender_user_id: ME,
        body: 'latest a',
        attachment_asset_ids: null,
        created_at: 't3',
      },
      {
        id: '2',
        channel_id: 'b',
        sender_user_id: null,
        body: null,
        attachment_asset_ids: ['v'],
        created_at: 't2',
      },
      {
        id: '1',
        channel_id: 'a',
        sender_user_id: ME,
        body: 'older a',
        attachment_asset_ids: null,
        created_at: 't1',
      },
    ]);
    expect(previews).toEqual([
      {
        channelId: 'a',
        messageId: '3',
        senderUserId: ME,
        body: 'latest a',
        hasAttachments: false,
        createdAt: 't3',
      },
      {
        channelId: 'b',
        messageId: '2',
        senderUserId: null,
        body: '',
        hasAttachments: true,
        createdAt: 't2',
      },
    ]);
  });
});
