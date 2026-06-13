import { describe, expect, it } from 'vitest';
import {
  fromAgoraUsername,
  toAgoraUsername,
  userIdFromAgoraUsername,
} from '@/lib/chat/agora-identity';

// Canonical UUID shape - what fromAgoraUsername must reconstruct.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Agora's accepted username charset.
const AGORA_CHARSET_RE = /^[a-z0-9_.-]+$/;

// Parity fixtures copied from the worker test (src/server/workers/agora-identity.test.ts).
// If the worker scheme changes, this port and this test must change with it.
describe('agora-identity frontend port', () => {
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
  });

  it('produces an Agora-legal, non-UUID-shaped username', () => {
    for (const id of ids) {
      const username = toAgoraUsername(id);
      expect(username.length).toBeLessThanOrEqual(64);
      expect(username).toMatch(AGORA_CHARSET_RE);
      expect(username.startsWith('u_')).toBe(true);
      expect(username).not.toMatch(UUID_RE);
      expect(username).not.toContain('-');
    }
  });

  it('throws on malformed input both directions', () => {
    expect(() => toAgoraUsername('not-a-uuid')).toThrow();
    expect(() => fromAgoraUsername('u_short')).toThrow();
  });

  it('userIdFromAgoraUsername returns a result instead of throwing on garbage', () => {
    const good = userIdFromAgoraUsername('u_a1b2c3d4e5f67890abcdef0123456789');
    expect(good).toEqual({ ok: true, userId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' });
    expect(userIdFromAgoraUsername('garbage')).toEqual({ ok: false });
  });
});
