import { describe, expect, it } from 'vitest';
import { fromAgoraUsername, toAgoraUsername } from '@/lib/chat/agora-identity';

// Parity guard: the frontend port must encode exactly like the worker scheme
// documented in src/server/workers/agora-identity.ts ("u_" + lowercased uuid
// with hyphens stripped). If either copy drifts, these assertions break.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('agora-identity port', () => {
  const ids = [
    '33333333-3333-7333-8333-333333333333',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    'AABBCCDD-EEFF-4011-8022-AABBCCDDEEFF',
  ];

  it('round-trips back to the lowercased original uuid', () => {
    for (const id of ids) {
      expect(fromAgoraUsername(toAgoraUsername(id))).toBe(id.toLowerCase());
      expect(fromAgoraUsername(toAgoraUsername(id))).toMatch(UUID_RE);
    }
  });

  it('matches the documented worker encoding byte-for-byte', () => {
    expect(toAgoraUsername('a1b2c3d4-e5f6-7890-abcd-ef0123456789')).toBe(
      'u_a1b2c3d4e5f67890abcdef0123456789',
    );
    expect(fromAgoraUsername('u_a1b2c3d4e5f67890abcdef0123456789')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    );
  });

  it('throws on non-UUID input and malformed usernames (crash early)', () => {
    expect(() => toAgoraUsername('not-a-uuid')).toThrow();
    expect(() => fromAgoraUsername('u_short')).toThrow();
  });
});
