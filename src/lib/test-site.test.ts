import { describe, expect, it } from 'vitest';
import { isTestEmail, isTestSite, testAddress, testInviteePath } from '@/lib/test-site';

describe('test site helpers', () => {
  it('only the test site host counts as the test site', () => {
    expect(isTestSite('test.srtdio-app.pages.dev')).toBe(true);
    expect(isTestSite('srtd.io')).toBe(false);
    expect(isTestSite('other.example')).toBe(false);
  });

  it('test addresses are the test.srtd.io domain only', () => {
    expect(isTestEmail('Approver-1a2b@test.srtd.io')).toBe(true);
    expect(isTestEmail('sam@srtd.io')).toBe(false);
    expect(isTestEmail('x@test.srtd.io.evil.com')).toBe(false);
  });

  it('a made-up address is a test address with the role in it', () => {
    const a = testAddress('approver');
    expect(a).toMatch(/^approver-[0-9a-f]{1,4}@test\.srtd\.io$/);
    expect(isTestEmail(a)).toBe(true);
  });

  it('the invitee link encodes the address', () => {
    expect(testInviteePath('A+B@test.srtd.io')).toBe('/test/invitee/a%2Bb%40test.srtd.io');
  });
});
