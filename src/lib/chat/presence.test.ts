import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  onlineFromStatusMap,
  parsePresenceEvent,
  parseSubscribePresence,
  PRESENCE_EVENT_HANDLER_ID,
  PRESENCE_SUBSCRIBE_EXPIRY_SECONDS,
  subscribePeerPresence,
  subscribePresenceChange,
  type PresenceConnection,
} from '@/lib/chat/presence';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

const PEER = '22222222-2222-4222-8222-222222222222';
const PEER_NAME = toAgoraUsername(PEER);

function sub(over: Partial<AgoraChat.SubscribePresence>): AgoraChat.SubscribePresence {
  return {
    uid: PEER_NAME,
    last_time: 1700,
    status: { webim: 1 },
    ext: '',
    expiry: 0,
    ...over,
  } as AgoraChat.SubscribePresence;
}

function evt(over: Partial<AgoraChat.PresenceType>): AgoraChat.PresenceType {
  return {
    userId: PEER_NAME,
    statusDetails: [{ device: 'webim', status: 1 }],
    lastTime: 1700,
    ext: '',
    expire: 0,
    ...over,
  } as AgoraChat.PresenceType;
}

function fakeConnection(over: Partial<PresenceConnection> = {}): PresenceConnection {
  return {
    open: vi.fn(),
    close: vi.fn(),
    renewToken: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    subscribePresence: vi.fn(),
    unsubscribePresence: vi.fn(),
    ...over,
  } as unknown as PresenceConnection;
}

describe('onlineFromStatusMap', () => {
  it('is online when any device is positive, offline otherwise', () => {
    expect(onlineFromStatusMap({ a: 1 })).toBe(true);
    expect(onlineFromStatusMap({ a: 0, b: 0 })).toBe(false);
    expect(onlineFromStatusMap({})).toBe(false);
  });
});

describe('parseSubscribePresence', () => {
  it('reads the peer entry, scales last_time to ms, and flags online', () => {
    expect(parseSubscribePresence([sub({})], PEER_NAME)).toEqual({
      online: true,
      lastTimeMs: 1700 * 1000,
    });
  });

  it('is offline when every device is zero', () => {
    expect(parseSubscribePresence([sub({ status: { webim: 0 } })], PEER_NAME)).toEqual({
      online: false,
      lastTimeMs: 1700 * 1000,
    });
  });

  it('returns null when the peer is absent', () => {
    expect(parseSubscribePresence([sub({ uid: 'u_other' })], PEER_NAME)).toBeNull();
  });
});

describe('parsePresenceEvent', () => {
  it('reads the peer change, scales lastTime to ms, and flags online', () => {
    expect(parsePresenceEvent([evt({})], PEER_NAME)).toEqual({
      online: true,
      lastTimeMs: 1700 * 1000,
    });
  });

  it('is offline when status details are all zero', () => {
    expect(
      parsePresenceEvent([evt({ statusDetails: [{ device: 'webim', status: 0 }] })], PEER_NAME),
    ).toEqual({ online: false, lastTimeMs: 1700 * 1000 });
  });

  it('returns null when the peer is absent', () => {
    expect(parsePresenceEvent([evt({ userId: 'u_other' })], PEER_NAME)).toBeNull();
  });
});

describe('subscribePeerPresence', () => {
  it('subscribes the peer with the expiry and returns the parsed state', async () => {
    const subscribePresence = vi.fn().mockResolvedValue({
      type: 0,
      data: { result: [sub({})] },
    });
    const connection = fakeConnection({ subscribePresence });

    const state = await subscribePeerPresence({ connection, peerUsername: PEER_NAME });

    expect(subscribePresence).toHaveBeenCalledWith({
      usernames: [PEER_NAME],
      expiry: PRESENCE_SUBSCRIBE_EXPIRY_SECONDS,
    });
    expect(state).toEqual({ online: true, lastTimeMs: 1700 * 1000 });
  });
});

describe('subscribePresenceChange', () => {
  it('registers a handler, delivers the peer change, and ignores other users', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = fakeConnection({
      addEventHandler: vi.fn((id: string, handler: AgoraChat.EventHandlerType) => {
        handlers[id] = handler;
      }),
      removeEventHandler: vi.fn(),
    });
    const onChange = vi.fn();

    const teardown = subscribePresenceChange({ connection, peerUsername: PEER_NAME, onChange });

    expect(connection.addEventHandler).toHaveBeenCalledWith(
      PRESENCE_EVENT_HANDLER_ID,
      expect.any(Object),
    );
    handlers[PRESENCE_EVENT_HANDLER_ID]?.onPresenceStatusChange?.([evt({})]);
    handlers[PRESENCE_EVENT_HANDLER_ID]?.onPresenceStatusChange?.([evt({ userId: 'u_other' })]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ online: true, lastTimeMs: 1700 * 1000 });

    teardown();
    expect(connection.removeEventHandler).toHaveBeenCalledWith(PRESENCE_EVENT_HANDLER_ID);
  });
});
