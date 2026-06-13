import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  echoMessage,
  mapTextMessage,
  sendText,
  type ChannelTarget,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import type { MessageAttachment } from '@/lib/chat/attachments';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const GROUP_TARGET: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

const ATTACHMENTS: MessageAttachment[] = [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }];

function fakeConnection(over: Partial<ThreadConnection> = {}): ThreadConnection {
  return {
    getHistoryMessages: vi.fn(),
    send: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    ...over,
  } as unknown as ThreadConnection;
}

function txt(ext: unknown): AgoraChat.TextMsgBody {
  return {
    id: 'm1',
    type: 'txt',
    chatType: 'singleChat',
    to: toAgoraUsername(ME),
    from: toAgoraUsername(PEER),
    msg: '',
    time: 1000,
    ext,
  } as unknown as AgoraChat.TextMsgBody;
}

describe('sendText with attachments', () => {
  it('carries attachment_asset_ids + render meta on the SDK message ext, plus optional text', async () => {
    const created = { id: 'created' } as unknown as AgoraChat.MessageBody;
    const createMessage = vi.fn().mockReturnValue(created);
    const send = vi.fn().mockResolvedValue({ serverMsgId: 's1', localMsgId: 'l1' });
    const connection = fakeConnection({ send });

    await sendText({
      connection,
      target: GROUP_TARGET,
      text: 'look',
      attachments: ATTACHMENTS,
      createMessage,
    });

    expect(createMessage).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'txt',
      to: 'agora-group-1',
      msg: 'look',
      ext: {
        attachment_asset_ids: ['a1'],
        attachment_meta: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      },
    });
    expect(send).toHaveBeenCalledWith(created);
  });
});

describe('mapTextMessage attachments', () => {
  it('reads attachments from the message ext meta', () => {
    const message = mapTextMessage(
      txt({
        attachment_asset_ids: ['a1'],
        attachment_meta: [{ assetId: 'a1', name: 'p.png', mime: 'image/png' }],
      }),
      ME,
    );
    expect(message.attachments).toEqual([{ assetId: 'a1', name: 'p.png', mime: 'image/png' }]);
  });

  it('reconstructs bare ids when a message carries only attachment_asset_ids', () => {
    const message = mapTextMessage(txt({ attachment_asset_ids: ['a1', 'a2'] }), ME);
    expect(message.attachments).toEqual([
      { assetId: 'a1', name: '', mime: '' },
      { assetId: 'a2', name: '', mime: '' },
    ]);
  });

  it('yields no attachments for a plain text message', () => {
    expect(mapTextMessage(txt(undefined), ME).attachments).toEqual([]);
  });
});

describe('echoMessage attachments', () => {
  it('carries the sent attachments onto the own-bubble echo', () => {
    const echo = echoMessage({
      result: { serverMsgId: 's1', localMsgId: 'l1' } as AgoraChat.SendMsgResult,
      text: '',
      currentUserId: ME,
      time: 5000,
      attachments: ATTACHMENTS,
    });
    expect(echo.attachments).toEqual(ATTACHMENTS);
  });
});
