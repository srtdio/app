import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';

// The chat shell never constructs the real SDK in tests. Mock the default export
// so importing thread.ts (which imports the SDK for message.create) is inert and
// send tests can assert the created message.
vi.mock('agora-chat', () => ({
  default: {
    message: {
      create: (options: Record<string, unknown>) => ({ ...options, id: 'local-1', time: 0 }),
    },
  },
}));

import {
  channelTarget,
  openThread,
  sendText,
  THREAD_EVENT_HANDLER_ID,
  type ThreadConnection,
  type ThreadTarget,
} from '@/lib/chat/thread';
import type { ChatChannelRow } from '@/lib/chat-reads';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

function channelRow(over: Partial<ChatChannelRow>): ChatChannelRow {
  return {
    agora_group_id: null,
    channel_id: 'c',
    channel_type: 'dm',
    created_at: '2026-06-01T00:00:00Z',
    dm_user_a: null,
    dm_user_b: null,
    entity_id: null,
    last_synced_at: null,
    workspace_id: 'ws-1',
    ...over,
  };
}

function textBody(over: Partial<AgoraChat.TextMsgBody>): AgoraChat.TextMsgBody {
  return {
    id: 'm',
    chatType: 'groupChat',
    type: 'txt',
    to: 'g1',
    msg: 'hi',
    from: toAgoraUsername(PEER),
    time: 1,
    ...over,
  } as AgoraChat.TextMsgBody;
}

interface MockClient {
  client: ThreadConnection;
  handlers: Map<string, AgoraChat.EventHandlerType>;
  history: AgoraChat.MessagesType[];
  sent: AgoraChat.MessageBody[];
}

function mockClient(history: AgoraChat.MessagesType[]): MockClient {
  const handlers = new Map<string, AgoraChat.EventHandlerType>();
  const sent: AgoraChat.MessageBody[] = [];
  const client = {
    open: () => Promise.resolve({}),
    close: () => {},
    renewToken: () => Promise.resolve({}),
    addEventHandler: (id: string, handler: AgoraChat.EventHandlerType) => handlers.set(id, handler),
    removeEventHandler: (id: string) => handlers.delete(id),
    getHistoryMessages: vi.fn(() => Promise.resolve({ messages: history, isLast: true })),
    send: (message: AgoraChat.MessageBody) => {
      sent.push(message);
      return Promise.resolve({ localMsgId: 'l', serverMsgId: 's' });
    },
  } as unknown as ThreadConnection;
  return { client, handlers, history, sent };
}

describe('channelTarget', () => {
  it('maps a group channel to its agora group id', () => {
    const target = channelTarget(
      channelRow({ channel_type: 'group', agora_group_id: 'g1', entity_id: 'grp' }),
      ME,
    );
    expect(target).toEqual({ targetId: 'g1', chatType: 'groupChat' });
  });

  it('maps a dm channel to the peer agora username', () => {
    const target = channelTarget(
      channelRow({ channel_type: 'dm', dm_user_a: ME, dm_user_b: PEER }),
      ME,
    );
    expect(target).toEqual({ targetId: toAgoraUsername(PEER), chatType: 'singleChat' });
  });

  it('returns null for an unaddressable channel', () => {
    expect(
      channelTarget(channelRow({ channel_type: 'group', agora_group_id: null }), ME),
    ).toBeNull();
  });
});

describe('openThread', () => {
  const target: ThreadTarget = { targetId: 'g1', chatType: 'groupChat' };

  it('fetches history from the SDK and registers the chat-thread handler', async () => {
    const history = [textBody({ id: 'b', time: 2 }), textBody({ id: 'a', time: 1 })];
    const { client, handlers } = mockClient(history);
    const onHistory = vi.fn();

    openThread({ client, target, onHistory, onIncoming: vi.fn() });

    expect(client.getHistoryMessages).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'g1', chatType: 'groupChat' }),
    );
    expect(handlers.has(THREAD_EVENT_HANDLER_ID)).toBe(true);
    await vi.waitFor(() => expect(onHistory).toHaveBeenCalled());
    // Oldest first, non-text filtered out.
    expect(onHistory.mock.calls[0]?.[0].map((m: { id: string }) => m.id)).toEqual(['a', 'b']);
  });

  it('appends matching incoming messages and ignores others', () => {
    const { client, handlers } = mockClient([]);
    const onIncoming = vi.fn();
    openThread({ client, target, onHistory: vi.fn(), onIncoming });

    const handler = handlers.get(THREAD_EVENT_HANDLER_ID);
    handler?.onTextMessage?.(textBody({ id: 'in', to: 'g1' }));
    handler?.onTextMessage?.(textBody({ id: 'other', to: 'g-other' }));

    expect(onIncoming).toHaveBeenCalledTimes(1);
    expect(onIncoming.mock.calls[0]?.[0]).toMatchObject({ id: 'in', body: 'hi' });
  });

  it('removes the handler on teardown', () => {
    const { client, handlers } = mockClient([]);
    const teardown = openThread({ client, target, onHistory: vi.fn(), onIncoming: vi.fn() });
    expect(handlers.has(THREAD_EVENT_HANDLER_ID)).toBe(true);
    teardown();
    expect(handlers.has(THREAD_EVENT_HANDLER_ID)).toBe(false);
  });
});

describe('sendText', () => {
  it('sends a created text message carrying the composed text', async () => {
    const { client, sent } = mockClient([]);
    await sendText({ client, target: { targetId: 'u_x', chatType: 'singleChat' }, text: 'hello' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'txt', to: 'u_x', chatType: 'singleChat', msg: 'hello' });
  });
});
