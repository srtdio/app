import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  appendMessage,
  belongsToTarget,
  echoMessage,
  loadHistory,
  mapTextMessage,
  sendText,
  subscribeIncoming,
  targetFromSummary,
  THREAD_EVENT_HANDLER_ID,
  type ChannelTarget,
  type ThreadConnection,
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

    const teardown = subscribeIncoming({
      connection,
      target: { targetId: toAgoraUsername(PEER), chatType: 'singleChat' },
      currentUserId: ME,
      onMessage,
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
    });
    expect(echo).toEqual({
      id: 's1',
      senderUserId: ME,
      body: 'yo',
      time: 5000,
      mine: true,
      attachments: [],
    });
  });

  it('does not append a duplicate id', () => {
    const base = mapTextMessage(txt({ id: 'dup' }), ME);
    expect(appendMessage([base], base)).toHaveLength(1);
    expect(appendMessage([base], mapTextMessage(txt({ id: 'new' }), ME))).toHaveLength(2);
  });
});
