import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page module reads supabase at import time; stub it so the pure helper can
// be imported without spinning up a real client (node-env, no network).
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

import {
  forgetNext,
  NEXT_STORAGE_KEY,
  readRememberedNext,
  rememberNext,
  sendSignInLink,
  type NextStore,
  type SignInAuthClient,
} from '../SignInPage';

function authClient(overrides: Partial<SignInAuthClient['auth']>): SignInAuthClient {
  return {
    auth: {
      signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

const ORIGIN = 'https://preview.example.test';

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: ORIGIN } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendSignInLink', () => {
  it('requests a sign-in link for an existing user and reports success', async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    const client = authClient({ signInWithOtp });

    const result = await sendSignInLink(client, 'a@b.com');

    expect(result).toEqual({ status: 'sent' });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.com',
      options: { shouldCreateUser: false, emailRedirectTo: ORIGIN },
    });
  });

  it('sends the current origin, not a hardcoded site, as the link redirect', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://other.example.test' } });
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });

    await sendSignInLink(authClient({ signInWithOtp }), 'a@b.com');

    expect(signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ emailRedirectTo: 'https://other.example.test' }),
      }),
    );
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

describe('remembered next', () => {
  function fakeStore(): NextStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
  }

  it('round-trips a safe destination and forgets it', () => {
    const store = fakeStore();
    rememberNext('/invite/accept/abc', store);
    expect(store.data.get(NEXT_STORAGE_KEY)).toBe('/invite/accept/abc');
    expect(readRememberedNext(store)).toBe('/invite/accept/abc');
    forgetNext(store);
    expect(readRememberedNext(store)).toBe('');
  });

  it('a request with no destination clears a stale one', () => {
    const store = fakeStore();
    rememberNext('/invite/accept/abc', store);
    rememberNext('', store);
    expect(readRememberedNext(store)).toBe('');
  });

  it('never stores or returns an unsafe destination', () => {
    const store = fakeStore();
    rememberNext('//evil.test', store);
    expect(store.data.has(NEXT_STORAGE_KEY)).toBe(false);
    store.data.set(NEXT_STORAGE_KEY, 'https://evil.test');
    expect(readRememberedNext(store)).toBe('');
  });

  it('survives a storage that throws', () => {
    const boom = (): never => {
      throw new Error('blocked');
    };
    const store: NextStore = { getItem: boom, setItem: boom, removeItem: boom };
    expect(() => rememberNext('/pipeline', store)).not.toThrow();
    expect(readRememberedNext(store)).toBe('');
    expect(() => forgetNext(store)).not.toThrow();
  });

  it('sendSignInLink keeps emailRedirectTo as the bare origin (template appends the callback)', async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
    await sendSignInLink(authClient({ signInWithOtp }), 'a@b.com');
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.com',
      options: { shouldCreateUser: false, emailRedirectTo: ORIGIN },
    });
  });
});
