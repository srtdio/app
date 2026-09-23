import { describe, expect, it, vi } from 'vitest';

// The hook's import graph reaches the agora-chat browser SDK through
// connection.ts; mock it so the pure key helper imports in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { connectionKey } from '@/lib/chat/use-chat-client';

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
