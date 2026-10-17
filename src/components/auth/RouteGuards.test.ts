import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { guestDestination, signInRedirect } from './RouteGuards';

describe('signInRedirect', () => {
  it('carries the invite path to /signin as ?next=', () => {
    expect(signInRedirect({ pathname: '/invite/accept/abc', search: '' })).toBe(
      '/signin?next=%2Finvite%2Faccept%2Fabc',
    );
  });

  it('keeps the query of the visited route', () => {
    expect(signInRedirect({ pathname: '/chat', search: '?channel=1' })).toBe(
      '/signin?next=%2Fchat%3Fchannel%3D1',
    );
  });
});

describe('guestDestination', () => {
  it('honours a safe ?next=', () => {
    expect(guestDestination('/invite/accept/abc', null)).toBe('/invite/accept/abc');
  });

  it('falls back to the { from } state', () => {
    expect(guestDestination(null, { from: '/posts/1' })).toBe('/posts/1');
  });

  it('never follows an absolute or protocol-relative next', () => {
    expect(guestDestination('https://evil.example', null)).toBe('/pipeline');
    expect(guestDestination('//evil.example', null)).toBe('/pipeline');
  });

  it('goes to /pipeline with nothing to honour', () => {
    expect(guestDestination(null, null)).toBe('/pipeline');
  });
});
