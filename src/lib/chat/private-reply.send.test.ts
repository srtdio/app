// Reply privately end to end through the lib: the draft's quote becomes the
// send's local content, the outbox records it through chat_private_reply_send
// (same id, trace, body, mentions, files), the optimistic and recorded bubbles
// carry the quote, the live ext carries the record's snapshot, a reload keeps
// a queued quoted send, and every read boundary parses private_reply with the
// one schema (a malformed value is refused).

import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';
import { privateReplySendArgs, sendMessageRecord } from '@/lib/chat/record';
import { runSend, type SendFlowDeps, type SendInput } from '@/lib/chat/send-flow';
import {
  readPersistedOutbox,
  writePersistedOutbox,
  type OutboxEntry,
  type OutboxStorage,
} from '@/lib/chat/chat-store';
import {
  buildLiveTextExt,
  LIVE_PRIVATE_REPLY_KEY,
  mapLiveTextMessage,
  mergeFetched,
  pendingMessage,
  rowToThreadMessage,
  type ChatMessageRow,
} from '@/lib/chat/thread';
import { parseChatOpenBundle } from '@/lib/chat/history';
import { classifyRecordFailure } from '@/lib/chat/send-errors';
import {
  privateReplyFromDraft,
  privateReplyToRow,
  type PrivateReply,
  type PrivateReplyDraft,
} from '@/lib/chat/private-reply';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ME = '11111111-1111-4111-8111-111111111111';
const ASHA = '22222222-2222-4222-8222-222222222222';
const DM = 'dm__ws__a__b';
const GROUP = 'group__ws__g1';
const ID = '019935a0-0000-7000-8000-000000000001';
const SOURCE = '019935a0-0000-7000-8000-0000000000aa';

const DRAFT: PrivateReplyDraft = {
  kind: 'chat',
  sourceId: SOURCE,
  authorUserId: ASHA,
  authorName: 'Asha Rao',
  excerpt: 'Can you send the deck?',
  whereLabel: 'Launch team',
  link: { kind: 'chat', channelId: GROUP, messageId: SOURCE },
};

const QUOTE: PrivateReply = privateReplyFromDraft(DRAFT);

/** The server's snapshot (its own excerpt and time). */
const SERVER_QUOTE: PrivateReply = {
  ...QUOTE,
  excerpt: 'Can you send the deck by Friday?',
  sourceCreatedAt: '2026-11-01T09:00:00+00:00',
};

function row(over: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: ID,
    channel_id: DM,
    workspace_id: 'ws',
    sender_user_id: ME,
    body: 'Sure',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    thread_root_message_id: null,
    forwarded_from_message_id: null,
    removed_files: {},
    private_reply: privateReplyToRow(SERVER_QUOTE),
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-11-02T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function input(over: Partial<SendInput> = {}): SendInput {
  return {
    id: ID,
    channelId: DM,
    currentUserId: ME,
    traceId: 'trace-1',
    text: 'Sure',
    local: { attachments: [], sharedPostIds: [], reply: null, privateReply: QUOTE },
    channelType: 'dm',
    ...over,
  };
}

function deps(over: Partial<SendFlowDeps> = {}): SendFlowDeps {
  return {
    recordMessage: vi.fn(async () => ({ ok: true as const, row: row() })),
    publishLive: vi.fn(async () => ({})),
    onLiveWarning: vi.fn(),
    ...over,
  };
}

/** A recording rpc builder with abortSignal (record.test.ts's fake). */
function makeClient(result: {
  data: unknown;
  error: { message: string; code?: string } | null;
  status?: number;
}) {
  const rpc = vi.fn(() => ({
    abortSignal: () => Promise.resolve(result),
  }));
  return { client: { rpc } as unknown as Client, rpc };
}

describe('send: chat_private_reply_send', () => {
  it('runSend hands the quote kind and source id to the record', async () => {
    const d = deps();
    const outcome = await runSend(d, input());
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        channelId: DM,
        traceId: 'trace-1',
        body: 'Sure',
        privateReply: { kind: 'chat', sourceId: SOURCE },
      }),
    );
    // The recorded bubble shows the server's snapshot.
    expect(outcome.ok && outcome.message.privateReply).toEqual(SERVER_QUOTE);
  });

  it('an ordinary send passes no privateReply', async () => {
    const plain = row({ private_reply: null });
    const d = deps({ recordMessage: vi.fn(async () => ({ ok: true as const, row: plain })) });
    await runSend(d, input({ local: { attachments: [], sharedPostIds: [], reply: null } }));
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ privateReply: expect.anything() }),
    );
  });

  it('the live publish carries the record snapshot, not the draft', async () => {
    const d = deps();
    await runSend(d, input());
    expect(d.publishLive).toHaveBeenCalledWith(
      expect.objectContaining({
        local: expect.objectContaining({ privateReply: SERVER_QUOTE }),
      }),
    );
  });

  it('sendMessageRecord calls chat_private_reply_send with the same id, trace, body, mentions and files', async () => {
    const { client, rpc } = makeClient({ data: row(), error: null });
    const result = await sendMessageRecord({
      client,
      id: ID,
      channelId: DM,
      traceId: 'trace-1',
      body: ' Sure ',
      attachmentAssetIds: ['v1'],
      mentions: [ASHA],
      attachmentMeta: { v1: { mime: 'image/png', name: 'a.png', size: 10 } },
      privateReply: { kind: 'chat', sourceId: SOURCE },
    });
    expect(rpc).toHaveBeenCalledWith('chat_private_reply_send', {
      p_id: ID,
      p_channel_id: DM,
      p_trace_id: 'trace-1',
      p_source_kind: 'chat',
      p_source_id: SOURCE,
      p_body: 'Sure',
      p_attachment_asset_ids: ['v1'],
      p_mentions: [ASHA],
      p_attachment_meta: { v1: { mime: 'image/png', name: 'a.png', size: 10 } },
    });
    expect(result.ok).toBe(true);
  });

  it('passes each source kind through', () => {
    for (const kind of ['chat', 'comment', 'plan_comment'] as const) {
      const args = privateReplySendArgs(
        { id: ID, channelId: DM, traceId: 't', body: 'x', attachmentAssetIds: [] },
        { kind, sourceId: 'src' },
      );
      expect(args.p_source_kind).toBe(kind);
      expect(args.p_source_id).toBe('src');
      expect(args).not.toHaveProperty('p_attachment_asset_ids');
      expect(args).not.toHaveProperty('p_mentions');
    }
  });

  it('without a quote it still calls chat_message_send', async () => {
    const { client, rpc } = makeClient({ data: row({ private_reply: null }), error: null });
    await sendMessageRecord({
      client,
      id: ID,
      channelId: DM,
      traceId: 'trace-1',
      body: 'Sure',
      attachmentAssetIds: [],
    });
    expect(rpc).toHaveBeenCalledWith('chat_message_send', expect.anything());
  });

  it('a refusal keeps its code and status, so it reads as permanent (Not sent)', async () => {
    const { client } = makeClient({
      data: null,
      error: { message: 'source not visible', code: '42501' },
      status: 403,
    });
    const result = await sendMessageRecord({
      client,
      id: ID,
      channelId: DM,
      traceId: 'trace-1',
      body: 'Sure',
      attachmentAssetIds: [],
      privateReply: { kind: 'chat', sourceId: SOURCE },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('42501');
    expect(classifyRecordFailure(result)).toBe('permanent');
  });

  it('a 503 stays transient (the clock keeps trying)', async () => {
    const { client } = makeClient({
      data: null,
      error: { message: 'unavailable' },
      status: 503,
    });
    const result = await sendMessageRecord({
      client,
      id: ID,
      channelId: DM,
      traceId: 'trace-1',
      body: 'Sure',
      attachmentAssetIds: [],
      privateReply: { kind: 'chat', sourceId: SOURCE },
    });
    expect(!result.ok && classifyRecordFailure(result)).toBe('transient');
  });
});

describe('bubble model', () => {
  it('the optimistic bubble shows the quote at once', () => {
    const pending = pendingMessage({
      id: ID,
      currentUserId: ME,
      text: 'Sure',
      local: { attachments: [], sharedPostIds: [], reply: null, privateReply: QUOTE },
      estimatedMs: 1,
    });
    expect(pending.privateReply).toEqual(QUOTE);
    expect(pending.state).toBe('sending');
  });

  it('a row maps private_reply through the schema; null is none; malformed throws', () => {
    expect(rowToThreadMessage(row(), ME).privateReply).toEqual(SERVER_QUOTE);
    expect(rowToThreadMessage(row({ private_reply: null }), ME)).not.toHaveProperty('privateReply');
    expect(() => rowToThreadMessage(row({ private_reply: { kind: 'chat' } }), ME)).toThrow();
  });

  it('a fetched row keeps the quote over a provisional live copy', () => {
    const live = { ...rowToThreadMessage(row({ private_reply: null }), ME), provisionalTime: true };
    const merged = mergeFetched([live], [rowToThreadMessage(row(), ME)]);
    expect(merged[0]?.privateReply).toEqual(SERVER_QUOTE);
  });

  it('the live ext carries the quote and the receiver maps it back', () => {
    const ext = buildLiveTextExt({
      attachments: [],
      sharedPostIds: [],
      reply: null,
      liveIds: { sorted_message_id: ID, sorted_channel_id: DM },
      privateReply: SERVER_QUOTE,
    });
    expect(ext?.[LIVE_PRIVATE_REPLY_KEY]).toEqual(privateReplyToRow(SERVER_QUOTE));
    const mapped = mapLiveTextMessage(
      {
        id: 'agora-1',
        type: 'txt',
        chatType: 'singleChat',
        msg: 'Sure',
        to: 'x',
        from: toAgoraUsername(ASHA),
        time: 1_762_000_000_000,
        ext,
      } as unknown as AgoraChat.TextMsgBody,
      ME,
    );
    expect(mapped.ok && mapped.message.privateReply).toEqual(SERVER_QUOTE);
  });

  it('a live message with no quote maps none', () => {
    const ext = buildLiveTextExt({
      attachments: [],
      sharedPostIds: [],
      reply: null,
      liveIds: { sorted_message_id: ID, sorted_channel_id: DM },
    });
    expect(ext).not.toHaveProperty(LIVE_PRIVATE_REPLY_KEY);
  });
});

describe('outbox persistence', () => {
  function memoryStorage(): OutboxStorage {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
  }
  const scope = { workspaceId: 'ws', userId: ME };

  it('a queued quoted send comes back with its quote after a reload', () => {
    const storage = memoryStorage();
    const queued: OutboxEntry = {
      id: ID,
      text: 'Sure',
      local: { attachments: [], sharedPostIds: [], reply: null, privateReply: QUOTE },
      state: 'sending',
    };
    writePersistedOutbox(storage, scope, { [DM]: [queued] });
    expect(readPersistedOutbox(storage, scope)[DM]?.[0]?.local.privateReply).toEqual(QUOTE);
  });

  it('a stored quote that no longer reads drops the entry (never sent as a plain message)', () => {
    const storage = memoryStorage();
    const queued = {
      id: ID,
      text: 'Sure',
      local: { attachments: [], sharedPostIds: [], reply: null, privateReply: { kind: 'chat' } },
      state: 'sending',
    } as unknown as OutboxEntry;
    writePersistedOutbox(storage, scope, { [DM]: [queued] });
    expect(readPersistedOutbox(storage, scope)[DM] ?? []).toEqual([]);
  });
});

describe('open bundle', () => {
  function bundle(privateReply: unknown): Record<string, unknown> {
    return {
      server_now: '2026-11-02T10:00:00+00:00',
      has_more: false,
      messages: [{ ...row(), private_reply: privateReply }],
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

  it('keeps a valid private_reply on the row', () => {
    const parsed = parseChatOpenBundle(bundle(privateReplyToRow(SERVER_QUOTE)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = parsed.data.page.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(rowToThreadMessage(first, ME).privateReply).toEqual(SERVER_QUOTE);
  });

  it('a malformed private_reply refuses the bundle', () => {
    const parsed = parseChatOpenBundle(bundle({ kind: 'chat', source_id: 'x' }));
    expect(parsed.ok).toBe(false);
  });
});
