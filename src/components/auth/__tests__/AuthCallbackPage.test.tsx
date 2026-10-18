import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Stub the supabase client so importing the page never spins up a real client,
// and so we can assert whether verifyOtp fires. Effects do not run under
// renderToStaticMarkup, which keeps these tests node-env and fast (no jsdom).
const { mockVerifyOtp } = vi.hoisted(() => ({ mockVerifyOtp: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { verifyOtp: mockVerifyOtp } } }));

import { RECOVERY_COPY, SIGNUP_CALLBACK_COPY } from '@/lib/induction-copy';
import {
  AuthCallbackPage,
  callbackCopyFor,
  callbackNext,
  ExpiredLinkView,
  isInviteDestination,
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

describe('callback next', () => {
  it('prefers a safe ?next= over the remembered destination', () => {
    expect(callbackNext('/invite/accept/a', '/briefs')).toBe('/invite/accept/a');
  });

  it('falls back to the remembered destination', () => {
    expect(callbackNext(null, '/invite/accept/a')).toBe('/invite/accept/a');
  });

  it.each(['//evil.test', 'https://evil.test', '/\\evil.test'])(
    'never returns an unsafe destination (%j)',
    (bad) => {
      expect(callbackNext(bad, '')).toBe('');
      expect(callbackNext(null, bad)).toBe('');
    },
  );

  it('recognises an invitation destination only with an id', () => {
    expect(isInviteDestination('/invite/accept/abc')).toBe(true);
    expect(isInviteDestination('/invite/accept/')).toBe(false);
    expect(isInviteDestination('/invite/accept')).toBe(false);
    expect(isInviteDestination('/pipeline')).toBe(false);
    expect(isInviteDestination('')).toBe(false);
  });
});

describe('expired link recovery', () => {
  function renderExpired(next: string): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ExpiredLinkView next={next} footer={null} />
      </MemoryRouter>,
    );
  }

  it('an invitation destination explains the invite expired and signs in back to it', () => {
    const html = renderExpired('/invite/accept/abc');
    expect(html).toContain(RECOVERY_COPY.expired);
    expect(html).toContain(`>${RECOVERY_COPY.signIn}</a>`);
    expect(html).toContain('href="/signin?next=%2Finvite%2Faccept%2Fabc"');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('This link has expired.');
  });

  it.each(['', '/pipeline'])('any other destination (%j) keeps the plain expired line', (next) => {
    const html = renderExpired(next);
    expect(html).toContain('This link has expired.');
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain(RECOVERY_COPY.expired);
  });

  it('a malformed link for an invitation shows invite recovery', () => {
    const html = renderAt('?type=magiclink&next=%2Finvite%2Faccept%2Fabc');
    expect(html).toContain(RECOVERY_COPY.expired);
    expect(html).toContain('href="/signin?next=%2Finvite%2Faccept%2Fabc"');
  });

  it('a malformed link with an unsafe next stays the plain invalid state', () => {
    const html = renderAt('?type=magiclink&next=%2F%2Fevil.test%2Finvite%2Faccept%2Fabc');
    expect(html).toContain('This link is not valid.');
    expect(html).not.toContain('evil.test');
  });

  it('the footer sign-in link carries a safe next', () => {
    const html = renderAt('?token_hash=abc&type=magiclink&next=%2Fposts%2F1');
    expect(html).toContain('href="/signin?next=%2Fposts%2F1"');
  });
});

describe('ready-state wording by link type', () => {
  it.each(['email', 'signup'] as const)('a %s link confirms the new account', (type) => {
    const html = renderAt(`?token_hash=abc&type=${type}`);
    expect(html).toContain(SIGNUP_CALLBACK_COPY.title);
    expect(html).toContain(SIGNUP_CALLBACK_COPY.subtitle);
    expect(html).toContain(`>${SIGNUP_CALLBACK_COPY.button}<`);
    expect(html).not.toContain('Sign in to Sorted');
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it.each(['magiclink', 'invite', 'recovery'] as const)(
    'a %s link keeps the sign-in wording',
    (type) => {
      const html = renderAt(`?token_hash=abc&type=${type}`);
      expect(html).toContain('Sign in to Sorted');
      expect(html).toContain('Tap the button to finish signing in on this device.');
      expect(html).toContain('>Sign in<');
      expect(html).not.toContain(SIGNUP_CALLBACK_COPY.title);
    },
  );

  it('callbackCopyFor picks the wording without rendering', () => {
    expect(callbackCopyFor('email')).toBe(SIGNUP_CALLBACK_COPY);
    expect(callbackCopyFor('magiclink').title).toBe('Sign in to Sorted');
  });
});
