import { describe, expect, it, vi } from 'vitest';

// The page module reads supabase at import time; stub it so the pure helper can
// be imported without spinning up a real client (node-env, no network).
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

import { sendSignInLink, type SignInAuthClient } from '../SignInPage';

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
