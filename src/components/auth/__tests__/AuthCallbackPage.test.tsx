import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Stub the supabase client so importing the page never spins up a real client,
// and so we can assert whether verifyOtp fires. Effects do not run under
// renderToStaticMarkup, which keeps these tests node-env and fast (no jsdom).
const { mockVerifyOtp } = vi.hoisted(() => ({ mockVerifyOtp: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { verifyOtp: mockVerifyOtp } } }));

import {
  AuthCallbackPage,
  narrowEmailOtpType,
  verifyMagicLink,
  type CallbackAuthClient,
} from '../AuthCallbackPage';

function authClient(result: { error: { message: string } | null }): CallbackAuthClient {
  return { auth: { verifyOtp: vi.fn().mockResolvedValue(result) } };
}

function renderAt(search: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/auth/callback${search}`]}>
      <AuthCallbackPage />
    </MemoryRouter>,
  );
}

describe('AuthCallbackPage render', () => {
  it('does NOT call verifyOtp on mount', () => {
    mockVerifyOtp.mockClear();
    const html = renderAt('?token_hash=abc123&type=magiclink');

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(html).toContain('Sign in to Sorted');
    expect(html).toContain('Sign in');
  });

  it('renders the invalid state without calling verifyOtp when token_hash is missing', () => {
    mockVerifyOtp.mockClear();
    const html = renderAt('?type=magiclink');

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(html).toContain('This link is not valid.');
    expect(html).toContain('Back to sign in');
  });
});

describe('verifyMagicLink', () => {
  it('calls verifyOtp exactly once with the parsed token_hash and type', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ error: null });
    const client: CallbackAuthClient = { auth: { verifyOtp } };

    const result = await verifyMagicLink(client, 'abc123', 'magiclink');

    expect(result).toEqual({ status: 'authenticated' });
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123', type: 'magiclink' });
  });

  it('reports error without surfacing the raw message when the token is expired', async () => {
    const client = authClient({ error: { message: 'Token has expired or is invalid' } });

    const result = await verifyMagicLink(client, 'abc123', 'magiclink');

    expect(result).toEqual({ status: 'error' });
  });
});

describe('narrowEmailOtpType', () => {
  it('accepts a known type', () => {
    expect(narrowEmailOtpType('magiclink')).toBe('magiclink');
  });

  it('rejects an unknown or absent type', () => {
    expect(narrowEmailOtpType('bogus')).toBeNull();
    expect(narrowEmailOtpType(null)).toBeNull();
  });
});
