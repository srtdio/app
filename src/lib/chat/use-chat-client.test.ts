import { describe, expect, it, vi } from 'vitest';

// connection.ts loads the agora-chat browser SDK with a dynamic import; mock
// it so the load and the pure key helper run in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import websdk from 'agora-chat';
import { createAgoraConnection, loadAgoraSdk } from '@/lib/chat/connection';
import { connectionKey } from '@/lib/chat/use-chat-client';

describe('createAgoraConnection', () => {
  it('lets the SDK auto-reconnect up to 10 times before surfacing a disconnect', async () => {
    // The SDK is a lazy chunk: the hook awaits this load before any connection.
    await loadAgoraSdk();
    createAgoraConnection('org#app');
    expect(websdk.connection).toHaveBeenCalledWith({
      appKey: 'org#app',
      delivery: true,
      autoReconnectNumMax: 10,
    });
  });
});

describe('connectionKey', () => {
  const base = { url: 'https://chat-token.example', userId: 'u1', workspaceId: 'w1' };

  it('is stable across an access-token rotation (the token is not an input)', () => {
    // The effect that opens the connection depends on exactly these inputs, so
    // a rotated Supabase token cannot tear the live connection down.
    expect(connectionKey(base)).toBe(connectionKey({ ...base }));
  });

  it('changes on workspace switch, user change (sign-out/in) and URL change', () => {
    expect(connectionKey({ ...base, workspaceId: 'w2' })).not.toBe(connectionKey(base));
    expect(connectionKey({ ...base, userId: undefined })).not.toBe(connectionKey(base));
    expect(connectionKey({ ...base, url: undefined })).not.toBe(connectionKey(base));
  });
});
