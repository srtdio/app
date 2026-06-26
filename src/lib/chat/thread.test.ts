import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  appendMessage,
  belongsToTarget,
  deliveredMessageId,
  echoMessage,
  loadHistory,
  mapTextMessage,
  markDelivered,
  markReadUpTo,
  sendText,
  subscribeIncoming,
  targetFromSummary,
  THREAD_EVENT_HANDLER_ID,
  type ChannelTarget,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import type { ChannelSummary } from '@/lib/chat-reads';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const GROUP_TARGET: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

function txt(over: Partial<AgoraChat.TextMsgBody>): AgoraChat.TextMsgBody {
  return {
    id: 'm1',
    type: 'txt',
    chatType: 'singleChat',
    to: toAgoraUsername(ME),
    from: toAgoraUsername(PEER),
    msg: 'hi',
    time: 1000,
    ...over,
  } as AgoraChat.TextMsgBody;
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
    getHistoryMessages: vi.fn(),
    send: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    ...over,
  } as unknown as ThreadConnection;
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

  it('returns null when the channel cannot be opened yet', () => {
    expect(targetFromSummary(groupSummary({ agoraGroupId: null }))).toBeNull();
    expect(targetFromSummary(dmSummary({ peerUserId: null }))).toBeNull();
  });
});

describe('mapTextMessage / belongsToTarget', () => {
  it('maps the Agora sender back to a Sorted user id and flags own messages', () => {
    expect(mapTextMessage(txt({}), ME)).toEqual({
      id: 'm1',
      senderUserId: PEER,
      body: 'hi',
      time: 1000,
      mine: false,
      attachments: [],
      sharedPostIds: [],
      status: 'sent',
    });
    expect(mapTextMessage(txt({ from: toAgoraUsername(ME) }), ME).mine).toBe(true);
  });

  it('keeps a null sender for an unmappable username instead of throwing', () => {
    expect(mapTextMessage(txt({ from: 'not-agora' }), ME).senderUserId).toBeNull();
  });

  it('matches DM messages from the peer and group messages addressed to the group', () => {
    expect(
      belongsToTarget(txt({}), { targetId: toAgoraUsername(PEER), chatType: 'singleChat' }),
    ).toBe(true);
    expect(
      belongsToTarget(txt({ from: 'u_other' }), {
        targetId: toAgoraUsername(PEER),
        chatType: 'singleChat',
      }),
    ).toBe(false);
    expect(belongsToTarget(txt({ chatType: 'groupChat', to: 'agora-group-1' }), GROUP_TARGET)).toBe(
      true,
    );
    expect(belongsToTarget(txt({ chatType: 'groupChat', to: 'other-group' }), GROUP_TARGET)).toBe(
      false,
    );
  });
});

describe('loadHistory', () => {
  it('fetches from the SDK and returns text messages oldest-first', async () => {
    const getHistoryMessages = vi.fn().mockResolvedValue({
      messages: [
        txt({ id: 'b', time: 2000 }),
        txt({ id: 'a', time: 1000 }),
        { id: 'cmd', type: 'cmd', time: 1500 } as unknown as AgoraChat.MessagesType,
      ],
    });
    const connection = fakeConnection({ getHistoryMessages });

    const history = await loadHistory({ connection, target: GROUP_TARGET, currentUserId: ME });

    expect(getHistoryMessages).toHaveBeenCalledWith({
      targetId: 'agora-group-1',
      chatType: 'groupChat',
      pageSize: 50,
    });
    expect(history.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('subscribeIncoming', () => {
  it('registers the chat-thread handler, delivers matching messages, and removes it on teardown', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
      removeEventHandler: vi.fn(),
    });
    const onMessage = vi.fn();
    const onDelivered = vi.fn();
    const onConversationRead = vi.fn();

    const teardown = subscribeIncoming({
      connection,
      target: { targetId: toAgoraUsername(PEER), chatType: 'singleChat' },
      currentUserId: ME,
      onMessage,
      onDelivered,
      onConversationRead,
    });

    expect(connection.addEventHandler).toHaveBeenCalledWith(
      THREAD_EVENT_HANDLER_ID,
      expect.any(Object),
    );
    handlers[THREAD_EVENT_HANDLER_ID]?.onTextMessage?.(txt({ id: 'live' }));
    handlers[THREAD_EVENT_HANDLER_ID]?.onTextMessage?.(txt({ id: 'other', from: 'u_someoneelse' }));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]?.id).toBe('live');

    teardown();
    expect(connection.removeEventHandler).toHaveBeenCalledWith(THREAD_EVENT_HANDLER_ID);
  });

  it('routes delivery and conversation-read receipts to their callbacks', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
    });
    const onDelivered = vi.fn();
    const onConversationRead = vi.fn();

    subscribeIncoming({
      connection,
      target: { targetId: toAgoraUsername(PEER), chatType: 'singleChat' },
      currentUserId: ME,
      onMessage: vi.fn(),
      onDelivered,
      onConversationRead,
    });
    const handler = handlers[THREAD_EVENT_HANDLER_ID];

    handler?.onDeliveredMessage?.({ mid: 'mid-1', ackId: 'ack-1' } as AgoraChat.DeliveryMsgBody);
    handler?.onDeliveredMessage?.({ ackId: 'ack-2' } as AgoraChat.DeliveryMsgBody);
    expect(onDelivered.mock.calls).toEqual([['mid-1'], ['ack-2']]);

    handler?.onChannelMessage?.({
      from: toAgoraUsername(PEER),
      time: 9000,
    } as AgoraChat.ChannelMsgBody);
    expect(onConversationRead).toHaveBeenCalledTimes(1);
    expect(onConversationRead).toHaveBeenCalledWith(9000);

    // A channel ack from a different user is ignored for this DM target.
    handler?.onChannelMessage?.({
      from: 'u_someoneelse',
      time: 9999,
    } as AgoraChat.ChannelMsgBody);
    expect(onConversationRead).toHaveBeenCalledTimes(1);
  });

  it('ignores conversation-read receipts for a group target', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
    });
    const onConversationRead = vi.fn();

    subscribeIncoming({
      connection,
      target: GROUP_TARGET,
      currentUserId: ME,
      onMessage: vi.fn(),
      onDelivered: vi.fn(),
      onConversationRead,
    });

    handlers[THREAD_EVENT_HANDLER_ID]?.onChannelMessage?.({
      from: GROUP_TARGET.targetId,
      time: 9000,
    } as AgoraChat.ChannelMsgBody);
    expect(onConversationRead).not.toHaveBeenCalled();
  });
});

describe('sendText', () => {
  it('creates a text message from the composed text and sends it via the SDK', async () => {
    const created = { id: 'created' } as unknown as AgoraChat.MessageBody;
    const createMessage = vi.fn().mockReturnValue(created);
    const send = vi.fn().mockResolvedValue({ serverMsgId: 's1', localMsgId: 'l1' });
    const connection = fakeConnection({ send });

    await sendText({
      connection,
      target: GROUP_TARGET,
      text: 'hello team',
      attachments: [],
      sharedPostIds: [],
      createMessage,
    });

    // A text-only send carries no `ext`: the options are exactly the text shape.
    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'hello team',
    });
    expect(send).toHaveBeenCalledWith(created);
  });
});

describe('echoMessage / appendMessage', () => {
  it('builds an own-bubble echo from the send result', () => {
    const echo = echoMessage({
      result: { serverMsgId: 's1', localMsgId: 'l1' } as AgoraChat.SendMsgResult,
      text: 'yo',
      currentUserId: ME,
      time: 5000,
      attachments: [],
      sharedPostIds: [],
    });
    expect(echo).toEqual({
      id: 's1',
      senderUserId: ME,
      body: 'yo',
      time: 5000,
      mine: true,
      attachments: [],
      sharedPostIds: [],
      status: 'sent',
    });
  });

  it('does not append a duplicate id', () => {
    const base = mapTextMessage(txt({ id: 'dup' }), ME);
    expect(appendMessage([base], base)).toHaveLength(1);
    expect(appendMessage([base], mapTextMessage(txt({ id: 'new' }), ME))).toHaveLength(2);
  });
});

function mine(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'x',
    senderUserId: ME,
    body: 'yo',
    time: 1000,
    mine: true,
    attachments: [],
    sharedPostIds: [],
    status: 'sent',
    ...over,
  };
}

describe('deliveredMessageId', () => {
  it('prefers mid, falls back to ackId, and is undefined when both are absent', () => {
    expect(deliveredMessageId({ mid: 'm', ackId: 'a' } as AgoraChat.DeliveryMsgBody)).toBe('m');
    expect(deliveredMessageId({ ackId: 'a' } as AgoraChat.DeliveryMsgBody)).toBe('a');
    expect(deliveredMessageId({} as AgoraChat.DeliveryMsgBody)).toBeUndefined();
  });
});

describe('markDelivered', () => {
  it('advances the matching own sent message and leaves everything else untouched', () => {
    const messages = [
      mine({ id: 'a', status: 'sent' }),
      mine({ id: 'b', status: 'sent' }),
      mine({ id: 'c', status: 'read' }),
      mine({ id: 'd', status: 'sent', mine: false }),
    ];
    const next = markDelivered(messages, 'a');
    expect(next.map((m) => m.status)).toEqual(['delivered', 'sent', 'read', 'sent']);
    // No downgrade: an already-read own message stays read even if acked.
    expect(markDelivered(messages, 'c')[2]?.status).toBe('read');
    // A non-mine message with the matching id is never changed.
    expect(markDelivered(messages, 'd')[3]?.status).toBe('sent');
  });
});

describe('markReadUpTo', () => {
  it('marks own messages at or before the read time as read, monotonically', () => {
    const messages = [
      mine({ id: 'a', time: 500, status: 'sent' }),
      mine({ id: 'b', time: 1000, status: 'delivered' }),
      mine({ id: 'c', time: 2000, status: 'sent' }),
      mine({ id: 'd', time: 500, status: 'read' }),
      mine({ id: 'e', time: 500, status: 'sent', mine: false }),
    ];
    const next = markReadUpTo(messages, 1000);
    expect(next.map((m) => m.status)).toEqual(['read', 'read', 'sent', 'read', 'sent']);
  });
});
