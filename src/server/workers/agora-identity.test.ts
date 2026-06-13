import { describe, expect, it } from 'vitest';
import { fromAgoraUsername, toAgoraUsername } from './agora-identity';

// Canonical UUID shape - what fromAgoraUsername must reconstruct.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Agora's accepted username charset.
const AGORA_CHARSET_RE = /^[a-z0-9_.-]+$/;

describe('toAgoraUsername / fromAgoraUsername', () => {
  // Includes all-lowercase and mixed-case spellings of the same id.
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

  it('is deterministic and case-insensitive on input', () => {
    const id = 'A1B2C3D4-E5F6-7890-ABCD-EF0123456789';
    expect(toAgoraUsername(id)).toBe(toAgoraUsername(id.toLowerCase()));
    expect(toAgoraUsername(id)).toBe('u_a1b2c3d4e5f67890abcdef0123456789');
  });

  it('produces an Agora-legal, non-UUID-shaped username', () => {
    for (const id of ids) {
      const username = toAgoraUsername(id);
      expect(username.length).toBeLessThanOrEqual(64);
      expect(username).toMatch(AGORA_CHARSET_RE);
      expect(username.startsWith('u_')).toBe(true);
      // The whole point: it must NOT be hyphenated-UUID form.
      expect(username).not.toMatch(UUID_RE);
      expect(username).not.toContain('-');
    }
  });

  it('throws on non-UUID input (crash early)', () => {
    expect(() => toAgoraUsername('not-a-uuid')).toThrow();
    expect(() => toAgoraUsername('u_33333333333373338333333333333333')).toThrow();
    expect(() => toAgoraUsername('')).toThrow();
    expect(() => toAgoraUsername('33333333-3333-7333-8333-33333333333')).toThrow();
    // @ts-expect-error exercising non-string input
    expect(() => toAgoraUsername(undefined)).toThrow();
  });

  it('throws on malformed username input', () => {
    expect(() => fromAgoraUsername('33333333-3333-7333-8333-333333333333')).toThrow();
    expect(() => fromAgoraUsername('u_short')).toThrow();
    expect(() => fromAgoraUsername('x_33333333333373338333333333333333')).toThrow();
    expect(() => fromAgoraUsername('u_33333333333373338333333333333333z')).toThrow();
    expect(() => fromAgoraUsername('')).toThrow();
    // @ts-expect-error exercising non-string input
    expect(() => fromAgoraUsername(null)).toThrow();
  });
});
