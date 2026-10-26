import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Client } from '@srtdio/rpc';
import {
  parseChatOpenBundle,
  readChatOpenBundle,
  rowPlanIds,
  type ChatOpenBundle,
} from '@/lib/chat/history';

const CH = 'dm__ws__a__b';
const WS = 'ws-1';

// A PostgREST-like builder: setHeader and abortSignal return the same builder,
// and awaiting it resolves the answer. rpc() returns it, so the X-Trace-Id the
// call stamps is observable beside the p_trace_id it sends.
function headerClient(answer: { data: unknown; error: null }) {
  const setHeader = vi.fn<(name: string, value: string) => unknown>();
  const abortSignal = vi.fn<(signal: AbortSignal) => unknown>();
  const builder = {
    setHeader,
    abortSignal,
    then: (resolve: (value: typeof answer) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(answer).then(resolve, reject),
  };
  setHeader.mockReturnValue(builder);
  abortSignal.mockReturnValue(builder);
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => typeof builder>(() => builder);
  return { client: { rpc } as unknown as Client, rpc, setHeader, abortSignal };
}

function msg(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `m${n}`,
    channel_id: CH,
    workspace_id: WS,
    sender_user_id: 'u1',
    body: `body ${n}`,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: `2026-10-26T10:00:${String(n).padStart(2, '0')}.000000+00:00`,
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
    removed_files: [],
    ...extra,
  };
}

/** A full bundle as chat_open_bundle returns it (jsonb). */
function raw(): Record<string, unknown> {
  return {
    server_now: '2026-10-26T10:01:00.000000+00:00',
    messages: [msg(1), msg(2, { reply_to_message_id: 'q1', shared_plan_ids: ['p2'] })],
    has_more: false,
    quoted: [msg(0, { id: 'q1', deleted_at: '2026-10-26T09:00:00Z', body: null })],
    reactions: [
      { message_id: 'm1', emoji: '👍', user_id: 'u1' },
      { message_id: 'm1', emoji: '👍', user_id: 'u2' },
    ],
    read_cursors: [
      {
        user_id: 'u2',
        last_read_message_id: 'm1',
        last_read_at: '2026-10-26T10:00:05Z',
        read_at: null,
      },
    ],
    cursor_messages: [{ id: 'm1', created_at: '2026-10-26T10:00:01.000000+00:00' }],
    reply_counts: [{ root_id: 'm1', reply_count: 3, last_reply_at: '2026-10-26T10:00:30Z' }],
    marks: [
      {
        message_id: 'm1',
        channel_id: CH,
        workspace_id: WS,
        mark_type: 'decision',
        priority: null,
        marked_by: 'u1',
        marked_at: '2026-10-26T10:00:10Z',
        resolved_by: null,
        resolved_at: null,
      },
      {
        message_id: 'm2',
        channel_id: CH,
        workspace_id: WS,
        mark_type: 'nonsense',
        priority: null,
        marked_by: 'u1',
        marked_at: '2026-10-26T10:00:10Z',
        resolved_by: null,
        resolved_at: null,
      },
    ],
    scheduled: [
      {
        id: 's2',
        channel_id: CH,
        workspace_id: WS,
        sender_user_id: 'u1',
        body: 'later',
        mentions: null,
        attachment_asset_ids: null,
        attachment_meta: null,
        shared_post_ids: null,
        shared_brief_ids: null,
        reply_to_message_id: null,
        send_at: '2026-10-28T09:00:00Z',
        status: 'scheduled',
        failure_reason: null,
        sent_at: null,
        created_at: '2026-10-26T09:00:00Z',
        updated_at: '2026-10-26T09:00:00Z',
      },
      {
        id: 's1',
        channel_id: CH,
        workspace_id: WS,
        sender_user_id: 'u1',
        body: 'sooner',
        mentions: null,
        attachment_asset_ids: null,
        attachment_meta: null,
        shared_post_ids: null,
        shared_brief_ids: null,
        reply_to_message_id: null,
        send_at: '2026-10-27T09:00:00Z',
        status: 'scheduled',
        failure_reason: null,
        sent_at: null,
        created_at: '2026-10-26T09:00:00Z',
        updated_at: '2026-10-26T09:00:00Z',
      },
    ],
    open_posts: [
      {
        id: 'post-1',
        number: 7,
        title: 'Reel',
        format: 'video',
        target_date: null,
        stage_entered_at: '2026-10-20T10:00:00Z',
        thumbnail_asset_version_id: 'v1',
      },
    ],
    open_post_count: 12,
    shared_plan_ids: ['p1'],
    open_briefs: [{ id: 'b1', number: 3, title: 'Brief', created_at: '2026-10-25T10:00:00Z' }],
    open_brief_count: 5,
  };
}

function parsed(data: unknown): ChatOpenBundle {
  const result = parseChatOpenBundle(data);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

describe('parseChatOpenBundle: every key mapped once', () => {
  it('maps all keys to the store shapes', () => {
    const b = parsed(raw());
    expect(b.serverNow).toBe('2026-10-26T10:01:00.000000+00:00');
    expect(b.page.rows.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(b.page.hasMore).toBe(false);
    expect(b.page.rows[1]?.reply_to_message_id).toBe('q1');
    expect(b.quoted.map((r) => [r.id, r.deleted_at !== null])).toEqual([['q1', true]]);
    expect(b.reactions).toHaveLength(2);
    expect(b.readPositions.rows).toEqual([
      { userId: 'u2', lastReadMessageId: 'm1', lastReadAt: '2026-10-26T10:00:05Z', readAt: null },
    ]);
    expect(b.readPositions.times.get('m1')).toBe(Date.parse('2026-10-26T10:00:01Z'));
    expect(b.replyCounts.get('m1')).toEqual({ count: 3 });
    // An unknown mark type is skipped, as the marks read does.
    expect(b.marks.map((m) => [m.messageId, m.type, m.resolved])).toEqual([
      ['m1', 'decision', false],
    ]);
    // Soonest first.
    expect(b.scheduled.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(b.openPosts).toEqual([
      {
        id: 'post-1',
        number: 7,
        title: 'Reel',
        format: 'video',
        target_date: null,
        stage_entered_at: '2026-10-20T10:00:00Z',
        thumbnailAssetVersionId: 'v1',
      },
    ]);
    expect(b.openPostCount).toBe(12);
    expect(b.sharedPlanIds).toEqual(['p1']);
    expect(b.openBriefs.map((x) => x.id)).toEqual(['b1']);
    expect(b.openBriefCount).toBe(5);
    expect(rowPlanIds(b.page.rows)).toEqual(['p2']);
  });

  it('has_more passes through as the server decided it (strict: only when more than 50)', () => {
    const fifty = { ...raw(), messages: Array.from({ length: 50 }, (_, i) => msg(i)) };
    expect(parsed({ ...fifty, has_more: false }).page.hasMore).toBe(false);
    expect(parsed({ ...fifty, has_more: true }).page.hasMore).toBe(true);
  });

  it('a nullable column absent from a row reads as null; an empty uuid[] may be null', () => {
    const m = msg(1);
    delete m.edited_at;
    delete m.removed_files;
    const b = parsed({ ...raw(), messages: [m], shared_plan_ids: null });
    expect(b.page.rows[0]?.edited_at).toBeNull();
    expect(b.page.rows[0]?.removed_files).toEqual([]);
    expect(b.sharedPlanIds).toEqual([]);
  });

  it.each([
    'server_now',
    'messages',
    'has_more',
    'quoted',
    'reactions',
    'read_cursors',
    'cursor_messages',
    'reply_counts',
    'marks',
    'scheduled',
    'open_posts',
    'open_post_count',
    'shared_plan_ids',
    'open_briefs',
    'open_brief_count',
  ])('a missing %s refuses the whole bundle', (key) => {
    const data = raw();
    delete data[key];
    const result = parseChatOpenBundle(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(key);
  });

  it.each<[string, unknown]>([
    ['not an object', null],
    ['a list', []],
    ['a string', 'x'],
    ['messages not a list', { ...raw(), messages: {} }],
    ['a message without an id', { ...raw(), messages: [{ ...msg(1), id: 5 }] }],
    ['a message without created_at', { ...raw(), messages: [{ ...msg(1), created_at: null }] }],
    ['has_more not a boolean', { ...raw(), has_more: 'yes' }],
    ['a reaction without emoji', { ...raw(), reactions: [{ message_id: 'm1', user_id: 'u' }] }],
    ['a count not a number', { ...raw(), open_post_count: 'many' }],
    ['shared ids not strings', { ...raw(), shared_plan_ids: [1] }],
    ['a body not a string', { ...raw(), messages: [{ ...msg(1), body: 3 }] }],
  ])('malformed (%s): a failed Result, never a throw', (_label, data) => {
    expect(() => parseChatOpenBundle(data)).not.toThrow();
    expect(parseChatOpenBundle(data).ok).toBe(false);
  });

  it('a numeric count sent as a string (bigint) still reads', () => {
    expect(parsed({ ...raw(), open_brief_count: '5' }).openBriefCount).toBe(5);
  });
});

describe('readChatOpenBundle', () => {
  it('stamps X-Trace-Id with the exact p_trace_id it sends, then attaches the signal', async () => {
    const { client, rpc, setHeader, abortSignal } = headerClient({ data: raw(), error: null });
    const signal = new AbortController().signal;
    const result = await readChatOpenBundle(
      client,
      { traceId: '0190a000-0000-7000-8000-0000000000bb', workspaceId: WS, channelId: CH },
      signal,
    );
    expect(result.ok).toBe(true);
    expect(rpc.mock.calls[0]?.[0]).toBe('chat_open_bundle');
    const traceId = rpc.mock.calls[0]?.[1].p_trace_id;
    expect(traceId).toBe('0190a000-0000-7000-8000-0000000000bb');
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', traceId);
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  function rpcClient(answer: { data: unknown; error: { message: string } | null }): {
    client: Client;
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const q = {
          abortSignal: () => q,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve),
        };
        return q;
      },
    } as unknown as Client;
    return { client, calls };
  }

  it('a cold open: one call, explicit p_trace_id, no p_since', async () => {
    const { client, calls } = rpcClient({ data: raw(), error: null });
    const result = await readChatOpenBundle(client, {
      traceId: '0190a000-0000-7000-8000-0000000000aa',
      workspaceId: WS,
      channelId: CH,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        name: 'chat_open_bundle',
        args: {
          p_trace_id: '0190a000-0000-7000-8000-0000000000aa',
          p_workspace_id: WS,
          p_channel_id: CH,
        },
      },
    ]);
  });

  it('catch-up passes p_since', async () => {
    const { client, calls } = rpcClient({ data: raw(), error: null });
    await readChatOpenBundle(client, {
      traceId: 't',
      workspaceId: WS,
      channelId: CH,
      since: '2026-10-26T10:00:01Z',
    });
    expect(calls[0]?.args.p_since).toBe('2026-10-26T10:00:01Z');
  });

  it('workspace_member_only maps to its code; other errors are unknown', async () => {
    const refused = await readChatOpenBundle(
      rpcClient({ data: null, error: { message: 'workspace_member_only' } }).client,
      { traceId: 't', workspaceId: WS, channelId: CH },
    );
    expect(refused.ok ? null : refused.error.code).toBe('workspace_member_only');
    const down = await readChatOpenBundle(
      rpcClient({ data: null, error: { message: 'boom' } }).client,
      { traceId: 't', workspaceId: WS, channelId: CH },
    );
    expect(down.ok ? null : down.error.code).toBe('unknown');
  });

  it('a malformed answer is a failed Result', async () => {
    const result = await readChatOpenBundle(rpcClient({ data: { nope: 1 }, error: null }).client, {
      traceId: 't',
      workspaceId: WS,
      channelId: CH,
    });
    expect(result.ok).toBe(false);
  });
});
