import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  appendMessage,
  applyReactionOp,
  compareMessages,
  mapLiveTextMessage,
  markReadUpTo,
  markReadUpToMessage,
  mergeFetched,
  mergeReactions,
  newestCursor,
  oldestCursor,
  parseLiveEvent,
  parseLiveIds,
  pendingMessage,
  reactionEventExt,
  readEventExt,
  rowToThreadMessage,
  sendText,
  setMessageState,
  subscribeIncoming,
  targetFromSummary,
  THREAD_EVENT_HANDLER_ID,
  upsertMessage,
  type ChannelTarget,
  type ChatMessageRow,
  type MessageReaction,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import type { ChannelSummary } from '@/lib/chat-reads';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = 'group__ws__g1';
const GROUP_TARGET: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

function txt(
  over: Omit<Partial<AgoraChat.TextMsgBody>, 'ext'> & { ext?: unknown | undefined },
): AgoraChat.TextMsgBody {
  return {
    id: 'agora-1',
    type: 'txt',
    chatType: 'groupChat',
    to: 'agora-group-1',
    from: toAgoraUsername(PEER),
    msg: 'hi',
    time: Date.parse('2026-09-22T10:00:05Z'),
    ext: { sorted_message_id: 'm-live', sorted_channel_id: CHANNEL },
    ...over,
  } as AgoraChat.TextMsgBody;
}

function cmd(over: Partial<AgoraChat.CmdMsgBody>): AgoraChat.CmdMsgBody {
  return {
    id: 'agora-cmd',
    type: 'cmd',
    chatType: 'groupChat',
    to: 'agora-group-1',
    from: toAgoraUsername(PEER),
    action: 'sorted_signal',
    time: 1,
    ...over,
  } as AgoraChat.CmdMsgBody;
}

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'm1',
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: PEER,
    body: 'hello',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    reply_to_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-09-22T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function groupSummary(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    channelId: 'c-group',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: 'agora-group-1',
    groupId: 'g-1',
    peerUserId: null,
    createdAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function dmSummary(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    channelId: 'c-dm',
    channelType: 'dm',
    title: 'Ada',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: PEER,
    createdAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function fakeConnection(over: Partial<ThreadConnection> = {}): ThreadConnection {
  return {
    send: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    renewToken: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    ...over,
  } as unknown as ThreadConnection;
}

function mine(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'x',
    senderUserId: ME,
    body: 'yo',
    createdAt: '2026-09-22T10:00:00+00:00',
    time: Date.parse('2026-09-22T10:00:00Z'),
    provisionalTime: false,
    mine: true,
    attachments: [],
    sharedPostIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

describe('targetFromSummary', () => {
  it('maps a synced group to its Agora group id', () => {
    expect(targetFromSummary(groupSummary())).toEqual(GROUP_TARGET);
  });

  it('maps a DM to the peer Agora username', () => {
    expect(targetFromSummary(dmSummary())).toEqual({
      targetId: toAgoraUsername(PEER),
      chatType: 'singleChat',
    });
  });

  it('returns null when the channel has no live target yet', () => {
    expect(targetFromSummary(groupSummary({ agoraGroupId: null }))).toBeNull();
    expect(targetFromSummary(dmSummary({ peerUserId: null }))).toBeNull();
  });
});

describe('parseLiveIds / parseLiveEvent', () => {
  it('reads both Sorted ids and rejects a message missing either', () => {
    expect(parseLiveIds({ sorted_message_id: 'a', sorted_channel_id: 'c' })).toEqual({
      ok: true,
      ids: { sorted_message_id: 'a', sorted_channel_id: 'c' },
    });
    expect(parseLiveIds({ sorted_message_id: 'a' })).toEqual({ ok: false });
    expect(parseLiveIds({ sorted_channel_id: 'c' })).toEqual({ ok: false });
    expect(parseLiveIds(undefined)).toEqual({ ok: false });
  });

  it('parses reaction and read signals and rejects anything else', () => {
    expect(parseLiveEvent(reactionEventExt({ messageId: 'm', emoji: '👍', op: 'add' }))).toEqual({
      kind: 'reaction',
      messageId: 'm',
      emoji: '👍',
      op: 'add',
    });
    expect(parseLiveEvent(readEventExt({ channelId: 'c', messageId: 'm' }))).toEqual({
      kind: 'read',
      channelId: 'c',
      messageId: 'm',
    });
    expect(
      parseLiveEvent({ sorted_event: 'reaction', message_id: 'm', emoji: '👍', op: 'x' }),
    ).toEqual({ kind: 'unknown' });
    expect(parseLiveEvent(undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('mapLiveTextMessage', () => {
  it('maps a stamped live message by its Sorted ids with the Agora server time', () => {
    const mapped = mapLiveTextMessage(txt({}), ME);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.channelId).toBe(CHANNEL);
    expect(mapped.message).toMatchObject({
      id: 'm-live',
      senderUserId: PEER,
      body: 'hi',
      time: Date.parse('2026-09-22T10:00:05Z'),
      createdAt: '2026-09-22T10:00:05.000Z',
      provisionalTime: true,
      mine: false,
      state: 'sent',
    });
  });

  it('ignores a live message without the Sorted ids (pre-rewrite client)', () => {
    expect(mapLiveTextMessage(txt({ ext: undefined }), ME)).toEqual({
      ok: false,
      reason: 'missing_ids',
    });
    expect(mapLiveTextMessage(txt({ ext: { attachment_asset_ids: [] } }), ME).ok).toBe(false);
  });

  it('flags own messages and keeps a null sender for an unmappable username', () => {
    const own = mapLiveTextMessage(txt({ from: toAgoraUsername(ME) }), ME);
    expect(own.ok && own.message.mine).toBe(true);
    const odd = mapLiveTextMessage(txt({ from: 'not-agora' }), ME);
    expect(odd.ok && odd.message.senderUserId).toBeNull();
  });

  it('reads attachments, shared posts and the reply quote off the ext', () => {
    const mapped = mapLiveTextMessage(
      txt({
        ext: {
          sorted_message_id: 'm-live',
          sorted_channel_id: CHANNEL,
          attachment_asset_ids: ['a1'],
          attachment_meta: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
          shared_post_ids: ['p1'],
          reply_to: { id: 'm0', author_user_id: PEER, preview: 'earlier' },
        },
      }),
      ME,
    );
    expect(mapped.ok && mapped.message.attachments).toEqual([
      { assetId: 'a1', name: 'p.png', mime: 'image/png' },
    ]);
    expect(mapped.ok && mapped.message.sharedPostIds).toEqual(['p1']);
    expect(mapped.ok && mapped.message.reply).toEqual({
      id: 'm0',
      authorUserId: PEER,
      preview: 'earlier',
    });
  });
});

describe('rowToThreadMessage', () => {
  it('maps a record row with the verbatim server created_at', () => {
    const message = rowToThreadMessage(row({}), ME);
    expect(message).toMatchObject({
      id: 'm1',
      senderUserId: PEER,
      body: 'hello',
      createdAt: '2026-09-22T10:00:00.123456+00:00',
      provisionalTime: false,
      mine: false,
      state: 'sent',
      status: 'sent',
    });
    expect(message.time).toBe(Date.parse('2026-09-22T10:00:00.123Z'));
  });

  it('renders bare asset ids from the row and prefers the local rich content', () => {
    const bare = rowToThreadMessage(row({ body: null, attachment_asset_ids: ['a1'] }), ME);
    expect(bare.body).toBe('');
    expect(bare.attachments).toEqual([{ assetId: 'a1', name: '', mime: '' }]);

    const rich = rowToThreadMessage(row({ sender_user_id: ME, attachment_asset_ids: ['a1'] }), ME, {
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      sharedPostIds: ['p1'],
      reply: { id: 'm0', authorUserId: PEER, preview: 'earlier' },
    });
    expect(rich.mine).toBe(true);
    expect(rich.attachments[0]?.name).toBe('p.png');
    expect(rich.sharedPostIds).toEqual(['p1']);
    expect(rich.reply?.id).toBe('m0');
  });
});

describe('list transitions', () => {
  it('orders by server time then id, and appendMessage drops a duplicate id', () => {
    const a = mine({ id: 'a', time: 1 });
    const b = mine({ id: 'b', time: 1 });
    const c = mine({ id: 'c', time: 2 });
    expect([c, b, a].sort(compareMessages).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(appendMessage([a], a)).toHaveLength(1);
    expect(appendMessage([c], a).map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('mergeFetched replaces a provisional live message with its row, keeping live content', () => {
    const live = mine({
      id: 'm1',
      mine: false,
      provisionalTime: true,
      time: Date.parse('2026-09-22T10:00:05Z'),
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      reactions: [{ emoji: '👍', count: 1, mine: true }],
    });
    const fetched = rowToThreadMessage(row({ attachment_asset_ids: ['a1'] }), ME);
    const merged = mergeFetched([live], [fetched]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.createdAt).toBe('2026-09-22T10:00:00.123456+00:00');
    expect(merged[0]?.provisionalTime).toBe(false);
    expect(merged[0]?.attachments[0]?.name).toBe('p.png');
    expect(merged[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  });

  it('mergeFetched leaves a recorded message alone and inserts new ids in order', () => {
    const recorded = mine({ id: 'm1', body: 'kept' });
    const older = rowToThreadMessage(
      row({ id: 'm0', created_at: '2026-09-22T09:00:00+00:00' }),
      ME,
    );
    const merged = mergeFetched([recorded], [older, rowToThreadMessage(row({ body: 'new' }), ME)]);
    expect(merged.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(merged[1]?.body).toBe('kept');
  });

  it('upsertMessage replaces by id and setMessageState flips one bubble', () => {
    const pending = mine({ id: 'p', state: 'sending', provisionalTime: true, createdAt: '' });
    const sent = mine({ id: 'p', state: 'sent' });
    expect(upsertMessage([pending], sent)[0]?.state).toBe('sent');
    expect(
      setMessageState([pending, mine({ id: 'q' })], 'p', 'failed').map((m) => m.state),
    ).toEqual(['failed', 'sent']);
  });

  it('pendingMessage orders after the newest loaded message and never reads a clock', () => {
    const last = mine({ id: 'z', time: 1000 });
    const pending = pendingMessage({
      id: 'p',
      currentUserId: ME,
      text: 'draft',
      local: { attachments: [], sharedPostIds: [], reply: null },
      after: [last],
    });
    expect(pending).toMatchObject({ id: 'p', time: 1001, state: 'sending', provisionalTime: true });
  });
});

describe('cursors', () => {
  it('read the oldest / newest RECORDED (created_at, id) and skip provisional entries', () => {
    const list = [
      mine({ id: 'a', createdAt: '2026-09-22T09:00:00+00:00', time: 1 }),
      mine({ id: 'b', createdAt: '2026-09-22T10:00:00+00:00', time: 2 }),
      mine({ id: 'live', provisionalTime: true, time: 3 }),
      mine({ id: 'pending', state: 'sending', provisionalTime: true, createdAt: '', time: 4 }),
    ];
    expect(oldestCursor(list)).toEqual({ createdAt: '2026-09-22T09:00:00+00:00', id: 'a' });
    expect(newestCursor(list)).toEqual({ createdAt: '2026-09-22T10:00:00+00:00', id: 'b' });
    expect(oldestCursor([])).toBeUndefined();
  });
});

describe('reactions', () => {
  it('applyReactionOp adds, counts, removes and is idempotent for own toggles', () => {
    const base = [mine({ id: 'm' })];
    const added = applyReactionOp(base, { messageId: 'm', emoji: '👍', op: 'add', mine: true });
    expect(added[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    const again = applyReactionOp(added, { messageId: 'm', emoji: '👍', op: 'add', mine: true });
    expect(again[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    const peer = applyReactionOp(again, { messageId: 'm', emoji: '👍', op: 'add', mine: false });
    expect(peer[0]?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    const removed = applyReactionOp(peer, {
      messageId: 'm',
      emoji: '👍',
      op: 'remove',
      mine: true,
    });
    expect(removed[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    const gone = applyReactionOp(removed, {
      messageId: 'm',
      emoji: '👍',
      op: 'remove',
      mine: false,
    });
    expect(gone[0]?.reactions).toEqual([]);
    expect(
      applyReactionOp(base, { messageId: 'other', emoji: '👍', op: 'add', mine: true }),
    ).toEqual(base);
  });

  it('mergeReactions sets reactions for mapped ids only', () => {
    const list = [mine({ id: 'a' }), mine({ id: 'b' })];
    const byId = new Map<string, MessageReaction[]>([
      ['a', [{ emoji: '❤️', count: 2, mine: false }]],
    ]);
    const merged = mergeReactions(list, byId);
    expect(merged[0]?.reactions).toEqual([{ emoji: '❤️', count: 2, mine: false }]);
    expect(merged[1]?.reactions).toEqual([]);
  });
});

describe('read ticks', () => {
  it('markReadUpTo advances own messages at or before the read time, monotonically', () => {
    const list = [
      mine({ id: 'a', time: 500 }),
      mine({ id: 'b', time: 1000 }),
      mine({ id: 'c', time: 2000 }),
      mine({ id: 'd', time: 500, mine: false }),
    ];
    expect(markReadUpTo(list, 1000).map((m) => m.status)).toEqual(['read', 'read', 'sent', 'sent']);
  });

  it('markReadUpToMessage resolves the id to its time and ignores an unknown id', () => {
    const list = [mine({ id: 'a', time: 500 }), mine({ id: 'b', time: 1000 })];
    expect(markReadUpToMessage(list, 'a').map((m) => m.status)).toEqual(['read', 'sent']);
    expect(markReadUpToMessage(list, 'zzz')).toEqual(list);
  });
});

describe('subscribeIncoming', () => {
  function subscribed(): {
    handler: AgoraChat.EventHandlerType | undefined;
    connection: ThreadConnection;
    onMessage: ReturnType<typeof vi.fn>;
    onIgnored: ReturnType<typeof vi.fn>;
    onReaction: ReturnType<typeof vi.fn>;
    onRead: ReturnType<typeof vi.fn>;
    teardown: () => void;
  } {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
    });
    const onMessage = vi.fn();
    const onIgnored = vi.fn();
    const onReaction = vi.fn();
    const onRead = vi.fn();
    const teardown = subscribeIncoming({
      connection,
      channelId: CHANNEL,
      currentUserId: ME,
      onMessage,
      onIgnored,
      onReaction,
      onRead,
    });
    return {
      handler: handlers[THREAD_EVENT_HANDLER_ID],
      connection,
      onMessage,
      onIgnored,
      onReaction,
      onRead,
      teardown,
    };
  }

  it('delivers stamped messages for the open channel only and removes the handler on teardown', () => {
    const s = subscribed();
    expect(s.connection.addEventHandler).toHaveBeenCalledWith(
      THREAD_EVENT_HANDLER_ID,
      expect.any(Object),
    );
    s.handler?.onTextMessage?.(txt({}));
    s.handler?.onTextMessage?.(
      txt({ ext: { sorted_message_id: 'other', sorted_channel_id: 'group__ws__g2' } }),
    );
    expect(s.onMessage).toHaveBeenCalledTimes(1);
    expect(s.onMessage.mock.calls[0]?.[0]?.id).toBe('m-live');
    s.teardown();
    expect(s.connection.removeEventHandler).toHaveBeenCalledWith(THREAD_EVENT_HANDLER_ID);
  });

  it('reports and drops a message without the Sorted ids', () => {
    const s = subscribed();
    s.handler?.onTextMessage?.(txt({ id: 'legacy', ext: undefined }));
    expect(s.onMessage).not.toHaveBeenCalled();
    expect(s.onIgnored).toHaveBeenCalledWith('legacy');
  });

  it('routes reaction and read signals with the mapped sender, filtering read by channel', () => {
    const s = subscribed();
    s.handler?.onCmdMessage?.(
      cmd({ ext: reactionEventExt({ messageId: 'm', emoji: '👍', op: 'add' }) }),
    );
    expect(s.onReaction).toHaveBeenCalledWith({
      messageId: 'm',
      emoji: '👍',
      op: 'add',
      fromUserId: PEER,
    });
    s.handler?.onCmdMessage?.(cmd({ ext: readEventExt({ channelId: CHANNEL, messageId: 'm' }) }));
    s.handler?.onCmdMessage?.(
      cmd({ ext: readEventExt({ channelId: 'elsewhere', messageId: 'm' }) }),
    );
    expect(s.onRead).toHaveBeenCalledTimes(1);
    expect(s.onRead).toHaveBeenCalledWith({ messageId: 'm', fromUserId: PEER });
    // A typing command (no ext) and an unmappable sender are ignored.
    s.handler?.onCmdMessage?.(cmd({ action: 'typing' }));
    s.handler?.onCmdMessage?.(
      cmd({ from: 'nobody', ext: reactionEventExt({ messageId: 'm', emoji: '👍', op: 'add' }) }),
    );
    expect(s.onReaction).toHaveBeenCalledTimes(1);
  });
});

describe('sendText', () => {
  it('stamps the Sorted ids on ext alongside the content ext', async () => {
    const created = { id: 'created' } as unknown as AgoraChat.MessageBody;
    const createMessage = vi.fn().mockReturnValue(created);
    const send = vi.fn().mockResolvedValue({ serverMsgId: 's1', localMsgId: 'l1' });
    const connection = fakeConnection({ send });

    await sendText({
      connection,
      target: GROUP_TARGET,
      text: 'hello team',
      attachments: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      sharedPostIds: ['p1'],
      reply: { id: 'm0', authorUserId: PEER, preview: 'earlier' },
      createMessage,
      liveIds: { sorted_message_id: 'm-new', sorted_channel_id: CHANNEL },
    });

    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'hello team',
      ext: {
        attachment_asset_ids: ['a1'],
        attachment_meta: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
        shared_post_ids: ['p1'],
        reply_to: { id: 'm0', author_user_id: PEER, preview: 'earlier' },
        sorted_message_id: 'm-new',
        sorted_channel_id: CHANNEL,
      },
    });
    expect(send).toHaveBeenCalledWith(created);
  });

  it('keeps the bare text shape (no ext) for an unstamped plain send', async () => {
    const createMessage = vi.fn().mockReturnValue({} as AgoraChat.MessageBody);
    await sendText({
      connection: fakeConnection({ send: vi.fn().mockResolvedValue({}) }),
      target: GROUP_TARGET,
      text: 'plain',
      attachments: [],
      sharedPostIds: [],
      reply: null,
      createMessage,
    });
    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'plain',
    });
  });
});
