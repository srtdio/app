import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// W12: tap-to-join (B29), switch account (B30), expired link (NEW10).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));

import {
  AcceptInvitePage,
  hasAuthErrorHash,
  INVITE_OTP_TYPE,
  joinWithTokenHash,
  signOutViaEvent,
  switchAccount,
  SWITCH_ACCOUNT_STATE,
} from '../AcceptInvitePage';
import { inviteExpiredCopy } from '../AuthCallbackPage';
import { isAccountSwitch, isPublicInviteVisit, signInRedirect } from '../RouteGuards';

function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invite/accept/:inviteId" element={<AcceptInvitePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('W12 tap-to-join page (B29)', () => {
  it('a ?th= link shows the workspace, the inviter, and one Join button, with no accept on render', () => {
    mockInvoke.mockReset();
    const html = render('/invite/accept/inv-1?th=hash-1&ws=Acme&by=Priya');
    expect(html).toContain('Join Acme');
    expect(html).toContain('Priya invited you to Acme on Sorted.');
    expect(html).not.toContain('Joining your workspace');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('signed out: Join verifies the token hash with type email, then accepts', async () => {
    const order: string[] = [];
    const verifyOtp = vi.fn(async () => {
      order.push('verify');
      return { error: null };
    });
    await joinWithTokenHash({
      tokenHash: 'hash-1',
      hasSession: async () => false,
      verifyOtp,
      accept: async () => {
        order.push('accept');
      },
      onExpired: () => order.push('expired'),
    });
    expect(INVITE_OTP_TYPE).toBe('email');
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'email' });
    expect(order).toEqual(['verify', 'accept']);
  });

  it('signed in: Join skips verify and accepts', async () => {
    const verifyOtp = vi.fn(async () => ({ error: null }));
    const accept = vi.fn(async () => {});
    await joinWithTokenHash({
      tokenHash: 'hash-1',
      hasSession: async () => true,
      verifyOtp,
      accept,
      onExpired: vi.fn(),
    });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledTimes(1);
  });
});

describe('W12 expired invite link (NEW10)', () => {
  it('an #error_code=otp_expired hash shows the expired view naming the inviter', () => {
    const html = render('/invite/accept/inv-1?by=Priya#error=access_denied&error_code=otp_expired');
    expect(html).toContain('This invite link has expired. Ask Priya to resend it.');
    expect(html).not.toContain('Joining your workspace');
  });

  it('a failed verify is the expired view, never an accept', async () => {
    const accept = vi.fn(async () => {});
    const onExpired = vi.fn();
    await joinWithTokenHash({
      tokenHash: 'used',
      hasSession: async () => false,
      verifyOtp: async () => ({ error: { message: 'Email link is invalid or has expired' } }),
      accept,
      onExpired,
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it('reads the Auth error hash and words the copy', () => {
    expect(hasAuthErrorHash('#error_code=otp_expired')).toBe(true);
    expect(hasAuthErrorHash('')).toBe(false);
    expect(inviteExpiredCopy('')).toBe(
      'This invite link has expired. Ask the person who invited you to resend it.',
    );
  });

  it('RequireAuth lets the signed-out invitee reach ?th= and #error_code invite links', () => {
    expect(
      isPublicInviteVisit({ pathname: '/invite/accept/inv-1', search: '?th=h', hash: '' }),
    ).toBe(true);
    expect(
      isPublicInviteVisit({
        pathname: '/invite/accept/inv-1',
        search: '',
        hash: '#error_code=otp_expired',
      }),
    ).toBe(true);
    expect(isPublicInviteVisit({ pathname: '/invite/accept/inv-1', search: '', hash: '' })).toBe(
      false,
    );
    expect(isPublicInviteVisit({ pathname: '/pipeline', search: '?th=h', hash: '' })).toBe(false);
  });

  it('keeps the hash on the sign-in redirect for invite routes only', () => {
    expect(
      signInRedirect({ pathname: '/invite/accept/inv-1', search: '', hash: '#error_code=x' }),
    ).toBe('/signin?next=%2Finvite%2Faccept%2Finv-1%23error_code%3Dx');
    expect(signInRedirect({ pathname: '/chat', search: '', hash: '#x' })).toBe(
      '/signin?next=%2Fchat',
    );
  });
});

describe('W12 use a different account (B30)', () => {
  it('signs out with sorted:signout before going to sign in', async () => {
    const order: string[] = [];
    vi.stubGlobal('window', {
      dispatchEvent: (event: Event) => {
        order.push(event.type);
        return true;
      },
    });
    await switchAccount({
      inviteId: 'inv-1',
      signOut: signOutViaEvent,
      navigate: (path) => order.push(`navigate ${path}`),
    });
    expect(order).toEqual(['sorted:signout', 'navigate /signin?next=%2Finvite%2Faccept%2Finv-1']);
  });

  it('RequireGuest does not bounce the switch back to the invite', () => {
    expect(isAccountSwitch(SWITCH_ACCOUNT_STATE)).toBe(true);
    expect(isAccountSwitch({ from: '/pipeline' })).toBe(false);
    expect(isAccountSwitch(null)).toBe(false);
  });
});
