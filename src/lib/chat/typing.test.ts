import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  cmdBelongsToTarget,
  sendTyping,
  subscribeTyping,
  TYPING_ACTION,
  TYPING_EVENT_HANDLER_ID,
  type TypingConnection,
} from '@/lib/chat/typing';
import type { ChannelTarget } from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const DM_TARGET: ChannelTarget = { targetId: toAgoraUsername(PEER), chatType: 'singleChat' };
const GROUP_TARGET: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

function cmd(over: Partial<AgoraChat.CmdMsgBody>): AgoraChat.CmdMsgBody {
  return {
    id: 'c1',
    type: 'cmd',
    chatType: 'singleChat',
    to: toAgoraUsername(ME),
    from: toAgoraUsername(PEER),
    action: TYPING_ACTION,
    time: 1000,
    ...over,
  } as AgoraChat.CmdMsgBody;
}

function fakeConnection(over: Partial<TypingConnection> = {}): TypingConnection {
  return {
    send: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    renewToken: vi.fn(),
    ...over,
  } as unknown as TypingConnection;
}

describe('sendTyping', () => {
  it('builds a typing cmd to the target and sends it once', async () => {
    const created = { id: 'created' } as unknown as AgoraChat.MessageBody;
    const createCmd = vi.fn().mockReturnValue(created);
    const send = vi.fn().mockResolvedValue({ serverMsgId: 's1', localMsgId: 'l1' });
    const connection = fakeConnection({ send });

    await sendTyping({ connection, target: GROUP_TARGET, createCmd });

    expect(createCmd).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'cmd',
      to: 'agora-group-1',
      action: 'typing',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(created);
  });
});

describe('cmdBelongsToTarget', () => {
  it('matches a peer cmd in the open DM', () => {
    expect(cmdBelongsToTarget(cmd({}), DM_TARGET)).toBe(true);
  });

  it('rejects a cmd for a different DM target', () => {
    expect(cmdBelongsToTarget(cmd({ from: 'u_someoneelse' }), DM_TARGET)).toBe(false);
  });

  it('matches a group cmd addressed to the group target', () => {
    expect(
      cmdBelongsToTarget(cmd({ chatType: 'groupChat', to: 'agora-group-1' }), GROUP_TARGET),
    ).toBe(true);
  });
});

describe('subscribeTyping', () => {
  function setup() {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
      removeEventHandler: vi.fn(),
    });
    const onTypingFrom = vi.fn();
    const teardown = subscribeTyping({
      connection,
      target: DM_TARGET,
      currentUserId: ME,
      onTypingFrom,
    });
    return { handlers, connection, onTypingFrom, teardown };
  }

  it('fires onTypingFrom with the mapped Sorted user id for a peer typing cmd', () => {
    const { handlers, onTypingFrom } = setup();
    handlers[TYPING_EVENT_HANDLER_ID]?.onCmdMessage?.(cmd({}));
    expect(onTypingFrom).toHaveBeenCalledTimes(1);
    expect(onTypingFrom).toHaveBeenCalledWith(PEER);
  });

  it('ignores a cmd whose sender maps to the current user', () => {
    const { handlers, onTypingFrom } = setup();
    handlers[TYPING_EVENT_HANDLER_ID]?.onCmdMessage?.(
      cmd({ from: toAgoraUsername(ME), to: toAgoraUsername(PEER) }),
    );
    expect(onTypingFrom).not.toHaveBeenCalled();
  });

  it('ignores a cmd with a non-typing action', () => {
    const { handlers, onTypingFrom } = setup();
    handlers[TYPING_EVENT_HANDLER_ID]?.onCmdMessage?.(cmd({ action: 'other' }));
    expect(onTypingFrom).not.toHaveBeenCalled();
  });

  it('removes exactly the chat-typing handler on teardown', () => {
    const { connection, teardown } = setup();
    teardown();
    expect(connection.removeEventHandler).toHaveBeenCalledWith(TYPING_EVENT_HANDLER_ID);
  });
});
