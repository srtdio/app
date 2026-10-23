import { describe, expect, it } from 'vitest';
import { DISPOSABLE_DOMAINS, isDisposableDomain } from './disposable-domains.ts';

describe('disposable domains', () => {
  it('matches a listed domain exactly', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('Yopmail.com')).toBe(true);
  });

  it('matches a sub-domain of a listed domain', () => {
    expect(isDisposableDomain('inbox.mailinator.com')).toBe(true);
    expect(isDisposableDomain('a.b.yopmail.com')).toBe(true);
  });

  it('does not match normal domains', () => {
    for (const domain of ['gmail.com', 'outlook.com', 'brand.com', 'srtd.io', 'test.srtd.io']) {
      expect(isDisposableDomain(domain)).toBe(false);
    }
  });

  it('does not match a domain that only ends with the same text', () => {
    expect(isDisposableDomain('brandmailinator.com')).toBe(false);
  });

  it('holds lower-case entries only', () => {
    for (const domain of DISPOSABLE_DOMAINS) expect(domain).toBe(domain.toLowerCase());
  });
});
