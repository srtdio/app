import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveLinkSigningKey,
  issueLinkKey,
  linkExpirySeconds,
  linkWindowStartSeconds,
  verifyLinkKey,
} from './file-links';

const USER = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';
// 2026-10-23 08:15:00 UTC
const NOW = Date.UTC(2026, 9, 23, 8, 15, 0);
const DAY = 24 * 60 * 60 * 1000;

let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  signingKey = await deriveLinkSigningKey('service-role-secret');
  otherKey = await deriveLinkSigningKey('a-different-secret');
});

describe('link windows', () => {
  it('gives every instant in a UTC day the same window start', () => {
    const start = linkWindowStartSeconds(Date.UTC(2026, 9, 23, 0, 0, 0));
    expect(linkWindowStartSeconds(NOW)).toBe(start);
    expect(linkWindowStartSeconds(Date.UTC(2026, 9, 23, 23, 59, 59))).toBe(start);
    expect(linkWindowStartSeconds(Date.UTC(2026, 9, 24, 0, 0, 0))).toBe(start + 86_400);
  });

  it('keeps a key valid until the end of the next UTC day', () => {
    expect(linkExpirySeconds(NOW) * 1000).toBe(Date.UTC(2026, 9, 25, 0, 0, 0));
  });
});

describe('issueLinkKey / verifyLinkKey', () => {
  it('round-trips: a fresh key verifies to its user', async () => {
    const minted = await issueLinkKey({ userId: USER, nowMs: NOW, signingKey });
    expect(await verifyLinkKey({ key: minted.key, nowMs: NOW, signingKey })).toBe(USER);
    expect(minted.expiresAt).toBe('2026-10-25T00:00:00.000Z');
  });

  it('mints the identical key all day, so file URLs repeat and cache', async () => {
    const morning = await issueLinkKey({
      userId: USER,
      nowMs: Date.UTC(2026, 9, 23, 0, 1, 0),
      signingKey,
    });
    const night = await issueLinkKey({
      userId: USER,
      nowMs: Date.UTC(2026, 9, 23, 23, 58, 0),
      signingKey,
    });
    expect(night.key).toBe(morning.key);
    const nextDay = await issueLinkKey({ userId: USER, nowMs: NOW + DAY, signingKey });
    expect(nextDay.key).not.toBe(morning.key);
  });

  it('rejects an expired key', async () => {
    const minted = await issueLinkKey({ userId: USER, nowMs: NOW, signingKey });
    expect(await verifyLinkKey({ key: minted.key, nowMs: NOW + 2 * DAY, signingKey })).toBeNull();
  });

  it('rejects a key whose user or expiry was swapped (tampered)', async () => {
    const minted = await issueLinkKey({ userId: USER, nowMs: NOW, signingKey });
    const [, exp, mac] = minted.key.split('.');
    expect(
      await verifyLinkKey({ key: `${OTHER}.${exp}.${mac}`, nowMs: NOW, signingKey }),
    ).toBeNull();
    const later = String(Number(exp) + 86_400);
    expect(
      await verifyLinkKey({ key: `${USER}.${later}.${mac}`, nowMs: NOW, signingKey }),
    ).toBeNull();
  });

  it('rejects a key signed with another secret, and malformed keys', async () => {
    const foreign = await issueLinkKey({ userId: USER, nowMs: NOW, signingKey: otherKey });
    expect(await verifyLinkKey({ key: foreign.key, nowMs: NOW, signingKey })).toBeNull();
    for (const bad of ['', 'x', `${USER}.1`, `${USER}.abc.def`, `not-a-uuid.9999999999.aaaa`]) {
      expect(await verifyLinkKey({ key: bad, nowMs: NOW, signingKey })).toBeNull();
    }
  });

  it('refuses to mint for a non-uuid user', async () => {
    await expect(issueLinkKey({ userId: 'nope', nowMs: NOW, signingKey })).rejects.toThrow('uuid');
  });
});
