import { describe, expect, it, vi } from 'vitest';

// The page module reads supabase at import time; stub it so the pure helper can
// be imported without spinning up a real client (node-env, no network).
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

import { sendSignInLink, signInWithPassword, type SignInAuthClient } from '../SignInPage';

function authClient(overrides: Partial<SignInAuthClient['auth']>): SignInAuthClient {
  return {
    auth: {
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

describe('sendSignInLink', () => {
  it('requests a sign-in link for an existing user and reports success', async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    const client = authClient({ signInWithOtp });

    const result = await sendSignInLink(client, 'a@b.com');

    expect(result).toEqual({ status: 'sent' });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.com',
      options: { shouldCreateUser: false },
    });
  });

  it('surfaces the provider error message and stays', async () => {
    const client = authClient({
      signInWithOtp: vi.fn().mockResolvedValue({ error: { message: 'no such user' } }),
    });

    const result = await sendSignInLink(client, 'a@b.com');

    expect(result).toEqual({ status: 'error', message: 'no such user' });
  });
});

describe('no account for the email', () => {
  it('turns the provider refusal into a create-account prompt', async () => {
    const client = authClient({
      signInWithOtp: vi
        .fn()
        .mockResolvedValue({ error: { message: 'Signups not allowed for otp' } }),
    });

    expect(await sendSignInLink(client, 'new@brand.com')).toEqual({ status: 'no-account' });
  });
});

describe('signInWithPassword', () => {
  it('signs in with a trimmed email', async () => {
    const signIn = vi.fn().mockResolvedValue({ error: null });
    const client = authClient({ signInWithPassword: signIn });

    expect(await signInWithPassword(client, ' a@b.com ', 'secret123')).toEqual({
      status: 'signed-in',
    });
    expect(signIn).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123' });
  });

  it('reports a wrong pair without saying which part', async () => {
    const client = authClient({
      signInWithPassword: vi
        .fn()
        .mockResolvedValue({ error: { message: 'Invalid login credentials' } }),
    });

    expect(await signInWithPassword(client, 'a@b.com', 'nope')).toEqual({ status: 'wrong' });
  });
});
