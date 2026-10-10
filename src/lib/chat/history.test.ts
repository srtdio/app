import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  DELETED_MESSAGE_LABEL,
  hydrateReplies,
  rowToThreadMessage,
  type ChatMessageRow,
} from '@/lib/chat/thread';
import {
  aggregateReactions,
  CATCH_UP_LIMIT,
  HISTORY_PAGE_SIZE,
  latestPerChannel,
  loadConversationPreviews,
  loadLatestMessages,
  loadMessageById,
  loadMessagesByIds,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
  loadThreadPage,
  loadThreadReplyCounts,
  loadUnreadCounts,
  newerThanFilter,
  olderThanFilter,
  rowPreviewContent,
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
    // Deleted rows come back as tombstones (the thread renders them).
    expect(argsOf(calls, 'is')).toEqual([]);
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

describe('thread reads', () => {
  it('a thread page filters on the thread root (its index), newest 50 first, returned oldest-first', async () => {
    const { client, calls } = makeClient({
      data: [
        { id: 'b', created_at: '2026-10-01T10:02:00Z' },
        { id: 'a', created_at: '2026-10-01T10:01:00Z' },
      ],
      error: null,
    });
    const page = await loadThreadPage(client, CHANNEL, 'root');
    expect(argsOf(calls, 'eq')).toEqual([
      ['channel_id', CHANNEL],
      ['thread_root_message_id', 'root'],
    ]);
    expect(argsOf(calls, 'or')).toEqual([]);
    expect(argsOf(calls, 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(argsOf(calls, 'limit')).toEqual([[HISTORY_PAGE_SIZE]]);
    expect(String(argsOf(calls, 'select')[0]?.[0])).toContain('thread_root_message_id');
    expect(page.ok && page.data.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.ok && page.data.hasMore).toBe(false);
  });

  it('an older thread page continues before the oldest loaded reply', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    const cursor = { createdAt: '2026-10-01T10:01:00Z', id: 'a' };
    await loadThreadPage(client, CHANNEL, 'root', cursor);
    expect(argsOf(calls, 'or')).toEqual([[olderThanFilter(cursor)]]);
  });

  it('counts go in one proc call with p_trace_id and at most 200 root ids', async () => {
    const { client, calls } = makeClient({
      data: [{ root_id: 'r1', reply_count: 4, last_reply_at: '2026-10-01T10:00:00Z' }],
      error: null,
    });
    const roots = Array.from({ length: 230 }, (_, i) => `r${i}`);
    const result = await loadThreadReplyCounts(client, CHANNEL, roots, 'trace-1');
    const rpc = argsOf(calls, 'rpc');
    expect(rpc).toHaveLength(1);
    expect(rpc[0]?.[0]).toBe('chat_thread_reply_counts');
    expect(rpc[0]?.[1]).toEqual({
      p_trace_id: 'trace-1',
      p_channel_id: CHANNEL,
      p_root_ids: roots.slice(0, 200),
    });
    expect(result.ok && result.data.get('r1')).toEqual({ count: 4 });
    // Nothing to count: no call at all.
    const none = makeClient({ data: [], error: null });
    await loadThreadReplyCounts(none.client, CHANNEL, [], 'trace-2');
    expect(argsOf(none.calls, 'rpc')).toEqual([]);
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
        attachmentKinds: [],
        sharedPostCount: 0,
        sharedBriefCount: 0,
        createdAt: 't3',
      },
      {
        channelId: 'b',
        messageId: '2',
        senderUserId: null,
        body: '',
        hasAttachments: true,
        attachmentKinds: ['file'],
        sharedPostCount: 0,
        sharedBriefCount: 0,
        createdAt: 't2',
      },
    ]);
  });
});

describe('deleted rows: returned where the thread renders them, filtered where they count', () => {
  const tombstone: Partial<ChatMessageRow> = {
    id: 'gone',
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: ME,
    body: null,
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    agora_event_id: null,
    created_at: '2026-09-22T10:00:01+00:00',
    edited_at: null,
    deleted_at: '2026-09-22T10:05:00+00:00',
  };

  it('latest, older, catch-up and by-ids reads carry no deleted_at filter', async () => {
    const reads: Array<(client: Client) => Promise<unknown>> = [
      (c) => loadLatestMessages(c, CHANNEL),
      (c) => loadOlderMessages(c, CHANNEL, CURSOR),
      (c) => loadNewerMessages(c, CHANNEL, CURSOR),
      (c) => loadMessagesByIds(c, ['gone']),
    ];
    for (const read of reads) {
      const { client, calls } = makeClient({ data: [], error: null });
      await read(client);
      expect(argsOf(calls, 'is')).toEqual([]);
    }
  });

  it('the live verifier and the conversation previews keep the deleted_at filter', async () => {
    const verify = makeClient({ data: null, error: null });
    await loadMessageById(verify.client, 'gone');
    expect(argsOf(verify.calls, 'is')).toEqual([['deleted_at', null]]);
    const previews = makeClient({ data: [], error: null });
    await loadConversationPreviews(previews.client, 'ws');
    expect(argsOf(previews.calls, 'is')).toEqual([['deleted_at', null]]);
  });

  it('after a reload a deleted row renders as a tombstone and a quote of it reads "Message deleted"', async () => {
    const reply: Partial<ChatMessageRow> = {
      ...tombstone,
      id: 'r',
      sender_user_id: 'peer',
      body: 'answer',
      created_at: '2026-09-22T10:00:02+00:00',
      reply_to_message_id: 'gone',
      deleted_at: null,
    };
    // Newest-first, as PostgREST returns the latest page.
    const page = await loadLatestMessages(
      makeClient({ data: [reply, tombstone], error: null }).client,
      CHANNEL,
    );
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const messages = page.data.rows.map((row) => rowToThreadMessage(row, ME));
    const [tomb, answer] = hydrateReplies(messages, [], true);
    expect(tomb).toMatchObject({
      id: 'gone',
      deleted: true,
      mine: true,
      body: '',
      attachments: [],
    });
    expect(answer?.reply?.preview).toBe(DELETED_MESSAGE_LABEL);
    expect(answer?.parentDeleted).toBe(true);
  });
});

describe('shared plans in reads and previews', () => {
  it('the message and preview columns include shared_plan_ids', async () => {
    const page = makeClient({ data: [], error: null });
    await loadLatestMessages(page.client, CHANNEL);
    expect(String(argsOf(page.calls, 'select')[0]?.[0])).toContain('shared_plan_ids');
    const previews = makeClient({ data: [], error: null });
    await loadConversationPreviews(previews.client, 'ws');
    expect(String(argsOf(previews.calls, 'select')[0]?.[0])).toContain('shared_plan_ids');
  });

  it('a plan-only row previews as a share with one plan', () => {
    const content = rowPreviewContent({
      body: null,
      attachment_asset_ids: null,
      attachment_meta: null,
      shared_post_ids: null,
      shared_brief_ids: null,
      shared_plan_ids: ['plan1'],
    });
    expect(content.hasAttachments).toBe(true);
    expect(content.sharedPlanCount).toBe(1);
    const latest = latestPerChannel([
      {
        id: 'm',
        channel_id: CHANNEL,
        sender_user_id: 'u',
        created_at: '2026-10-09T10:00:00Z',
        shared_plan_ids: ['plan1'],
      },
    ]);
    expect(latest[0]?.sharedPlanCount).toBe(1);
  });
});
