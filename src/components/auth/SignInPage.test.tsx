import { describe, expect, it, vi } from 'vitest';

// The page module reads supabase at import time; stub it so the pure helpers
// can be imported without spinning up a real client (node-env, no network).
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

import {
  resolveDestination,
  sendOtpCode,
  verifyOtpCode,
  type SignInAuthClient,
} from './SignInPage';

function authClient(overrides: Partial<SignInAuthClient['auth']>): SignInAuthClient {
  return {
    auth: {
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      verifyOtp: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

describe('sendOtpCode', () => {
  it('requests a code for an existing user and reports success', async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    const client = authClient({ signInWithOtp });

    const result = await sendOtpCode(client, 'a@b.com', 'https://app.test/');

    expect(result).toEqual({ status: 'sent' });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.com',
      options: { shouldCreateUser: false, emailRedirectTo: 'https://app.test/' },
    });
  });

  it('surfaces the provider error message and stays', async () => {
    const client = authClient({
      signInWithOtp: vi.fn().mockResolvedValue({ error: { message: 'no such user' } }),
    });

    const result = await sendOtpCode(client, 'a@b.com', 'https://app.test/');

    expect(result).toEqual({ status: 'error', message: 'no such user' });
  });
});

describe('verifyOtpCode', () => {
  it('authenticates on a correct code', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ error: null });
    const client = authClient({ verifyOtp });

    const result = await verifyOtpCode(client, 'a@b.com', '123456');

    expect(result).toEqual({ status: 'authenticated' });
    expect(verifyOtp).toHaveBeenCalledWith({ email: 'a@b.com', token: '123456', type: 'email' });
  });

  it('surfaces the provider error for a wrong or expired code', async () => {
    const client = authClient({
      verifyOtp: vi.fn().mockResolvedValue({ error: { message: 'Token has expired' } }),
    });

    const result = await verifyOtpCode(client, 'a@b.com', '000000');

    expect(result).toEqual({ status: 'error', message: 'Token has expired' });
  });
});

describe('resolveDestination', () => {
  it('honors a same-origin path from', () => {
    expect(resolveDestination('/inbox')).toBe('/inbox');
  });

  it('rejects a protocol-relative path', () => {
    expect(resolveDestination('//evil.com')).toBe('/pipeline');
  });

  it('rejects non-string values', () => {
    expect(resolveDestination(undefined)).toBe('/pipeline');
    expect(resolveDestination(null)).toBe('/pipeline');
    expect(resolveDestination({ from: '/x' })).toBe('/pipeline');
    expect(resolveDestination(42)).toBe('/pipeline');
  });

  it('defaults to /pipeline for a path without a leading slash', () => {
    expect(resolveDestination('pipeline')).toBe('/pipeline');
  });
});
