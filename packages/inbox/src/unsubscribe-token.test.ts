import { describe, expect, it } from 'vitest';
import { UNSUBSCRIBE_TEST_VECTOR } from './catchup-contracts';
import {
  buildOneClickUrl,
  buildUnsubscribePageUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from './unsubscribe-token';

const { userId, secret, token } = UNSUBSCRIBE_TEST_VECTOR;
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

function flipChar(value: string, index: number): string {
  const current = value.charAt(index);
  const replacement = current === 'A' ? 'B' : 'A';
  return value.slice(0, index) + replacement + value.slice(index + 1);
}

describe('signUnsubscribeToken', () => {
  it('matches the shared fixed vector', async () => {
    await expect(signUnsubscribeToken(userId, secret)).resolves.toBe(token);
  });

  it('is base64url with no padding', async () => {
    const signed = await signUnsubscribeToken(userId, secret);
    expect(signed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signed).toHaveLength(43);
  });

  it('is deterministic and differs per user and per secret', async () => {
    const again = await signUnsubscribeToken(userId, secret);
    const other = await signUnsubscribeToken(OTHER_USER, secret);
    const rotated = await signUnsubscribeToken(userId, 'another-secret');
    expect(again).toBe(token);
    expect(other).not.toBe(token);
    expect(rotated).not.toBe(token);
  });
});

describe('verifyUnsubscribeToken', () => {
  it('accepts the shared fixed vector', async () => {
    await expect(verifyUnsubscribeToken(userId, token, secret)).resolves.toBe(true);
  });

  it('accepts a freshly signed token for another user', async () => {
    const signed = await signUnsubscribeToken(OTHER_USER, secret);
    await expect(verifyUnsubscribeToken(OTHER_USER, signed, secret)).resolves.toBe(true);
  });

  it.each([
    ['one character flipped (first)', flipChar(token, 0)],
    ['one character flipped (middle)', flipChar(token, 20)],
    ['truncated by one character', token.slice(0, -1)],
    ['truncated to half', token.slice(0, 21)],
    ['extended by one character', `${token}A`],
    ['empty', ''],
    ['garbage non-base64', '!!!not*base64%%%'],
    ['whitespace only', '   '],
  ])('rejects a token that is %s, without throwing', async (_label, candidate) => {
    await expect(verifyUnsubscribeToken(userId, candidate, secret)).resolves.toBe(false);
  });

  it('rejects the token presented for another user id', async () => {
    await expect(verifyUnsubscribeToken(OTHER_USER, token, secret)).resolves.toBe(false);
  });

  it('rejects the token under the wrong secret', async () => {
    await expect(verifyUnsubscribeToken(userId, token, 'wrong-secret')).resolves.toBe(false);
  });

  it('rejects an empty user id', async () => {
    await expect(verifyUnsubscribeToken('', token, secret)).resolves.toBe(false);
  });
});

describe('buildUnsubscribePageUrl', () => {
  it('builds {APP_BASE_URL}/unsubscribe?u=..&t=..', () => {
    const url = new URL(buildUnsubscribePageUrl('https://app.test', userId, token));
    expect(url.origin).toBe('https://app.test');
    expect(url.pathname).toBe('/unsubscribe');
    expect(url.searchParams.get('u')).toBe(userId);
    expect(url.searchParams.get('t')).toBe(token);
  });

  it('tolerates a trailing slash on the base', () => {
    const withSlash = buildUnsubscribePageUrl('https://app.test/', userId, token);
    const withoutSlash = buildUnsubscribePageUrl('https://app.test', userId, token);
    expect(withSlash).toBe(withoutSlash);
    expect(withSlash).not.toContain('//unsubscribe');
  });

  it('encodes query values so they round-trip', () => {
    const oddUser = 'a b&c=d?e#f';
    const oddToken = 'x+y/z=';
    const raw = buildUnsubscribePageUrl('https://app.test', oddUser, oddToken);
    expect(raw).not.toContain('a b');
    expect(raw).not.toContain('#');
    const url = new URL(raw);
    expect(url.pathname).toBe('/unsubscribe');
    expect(url.searchParams.get('u')).toBe(oddUser);
    expect(url.searchParams.get('t')).toBe(oddToken);
    expect([...url.searchParams.keys()].sort()).toEqual(['t', 'u']);
  });
});

describe('buildOneClickUrl', () => {
  it('builds {SUPABASE_URL}/functions/v1/catchup-unsubscribe?u=..&t=..', () => {
    const url = new URL(buildOneClickUrl('https://db.test', userId, token));
    expect(url.origin).toBe('https://db.test');
    expect(url.pathname).toBe('/functions/v1/catchup-unsubscribe');
    expect(url.searchParams.get('u')).toBe(userId);
    expect(url.searchParams.get('t')).toBe(token);
  });

  it('tolerates a trailing slash on the base', () => {
    const withSlash = buildOneClickUrl('https://db.test/', userId, token);
    expect(withSlash).toBe(buildOneClickUrl('https://db.test', userId, token));
    expect(new URL(withSlash).pathname).toBe('/functions/v1/catchup-unsubscribe');
  });

  it('encodes query values so they round-trip', () => {
    const oddUser = 'a b&c=d?e#f';
    const oddToken = 'x+y/z=';
    const url = new URL(buildOneClickUrl('https://db.test', oddUser, oddToken));
    expect(url.searchParams.get('u')).toBe(oddUser);
    expect(url.searchParams.get('t')).toBe(oddToken);
    expect([...url.searchParams.keys()].sort()).toEqual(['t', 'u']);
  });
});
