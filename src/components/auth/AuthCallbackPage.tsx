import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { EmailOtpType } from '@supabase/supabase-js';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import {
  forgetNext,
  readRememberedNext,
  safeNextPath,
  withNext,
} from '@/components/auth/SignInPage';
import { RECOVERY_COPY } from '@/lib/induction-copy';
import { supabase } from '@/lib/supabase';

/**
 * The minimal slice of the Supabase auth client the callback needs, so tests
 * can mock it without constructing a full client.
 */
export interface CallbackAuthClient {
  auth: {
    verifyOtp(params: {
      token_hash: string;
      type: EmailOtpType;
    }): Promise<{ error: { message: string } | null }>;
  };
}

// EmailOtpType widens to `string & {}` in supabase-js, so it never rejects an
// arbitrary query value at the type level. Guard the runtime value against this
// explicit whitelist instead; anything else is treated as a malformed link.
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
];

/** Narrow a raw query value to a known EmailOtpType, or null when unrecognised. */
export function narrowEmailOtpType(value: string | null): EmailOtpType | null {
  return value !== null && EMAIL_OTP_TYPES.includes(value) ? value : null;
}

export type VerifyResult = { status: 'authenticated' } | { status: 'error' };

/**
 * Exchange a magic-link token_hash for a session. The raw provider error is
 * never surfaced; callers render a fixed "expired" message on failure.
 */
export async function verifyMagicLink(
  client: CallbackAuthClient,
  tokenHash: string,
  type: EmailOtpType,
): Promise<VerifyResult> {
  const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  return error ? { status: 'error' } : { status: 'authenticated' };
}

/** Where a verified user lands when the link carried no safe destination. */
export const DEFAULT_AFTER_CALLBACK = '/pipeline';

const INVITE_PATH_PREFIX = '/invite/accept/';

/**
 * The post-sign-in destination: a safe ?next= on the link first, then the one
 * SignInPage remembered on this device when it sent the link. '' when neither.
 */
export function callbackNext(queryNext: string | null, remembered: string): string {
  return safeNextPath(queryNext) || safeNextPath(remembered);
}

/** True when the destination is an invitation, so an expired link gets invite recovery. */
export function isInviteDestination(next: string): boolean {
  return next.startsWith(INVITE_PATH_PREFIX) && next.length > INVITE_PATH_PREFIX.length;
}

const PRIMARY_LINK_CLASS =
  'inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover';

/**
 * The expired-link screen. An invitation destination explains the invite has
 * expired and offers sign-in that returns to the invitation; any other link
 * keeps the plain expired message.
 */
export function ExpiredLinkView(props: { next: string; footer: ReactNode }): ReactElement {
  if (isInviteDestination(props.next)) {
    return (
      <AuthShell title="Sign in to Sorted" subtitle={RECOVERY_COPY.expired} footer={props.footer}>
        <Link to={withNext('/signin', props.next)} className={PRIMARY_LINK_CLASS}>
          {RECOVERY_COPY.signIn}
        </Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Sign in to Sorted" subtitle="This link has expired." footer={props.footer}>
      <Link to="/signin" className={PRIMARY_LINK_CLASS}>
        Back to sign in
      </Link>
    </AuthShell>
  );
}

const client = supabase as unknown as CallbackAuthClient;

/**
 * Two-step magic-link landing. The email link points here (our page) carrying
 * token_hash, NOT at Supabase's verify endpoint, because corporate mail
 * scanners prefetch links and a verify URL would be consumed on prefetch. This
 * page therefore NEVER verifies on mount; it verifies only on an explicit click.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tokenHash = searchParams.get('token_hash');
  const type = narrowEmailOtpType(searchParams.get('type'));
  // Read once per render; the remembered value is re-validated before use.
  const next = callbackNext(searchParams.get('next'), readRememberedNext());
  const [phase, setPhase] = useState<'ready' | 'signing' | 'expired'>('ready');

  const invalid = tokenHash === null || tokenHash === '' || type === null;

  async function handleSignIn(): Promise<void> {
    if (tokenHash === null || tokenHash === '' || type === null) return;
    setPhase('signing');
    const result = await verifyMagicLink(client, tokenHash, type);
    if (result.status === 'error') {
      setPhase('expired');
      return;
    }
    forgetNext();
    navigate(next || DEFAULT_AFTER_CALLBACK, { replace: true });
  }

  const backToSignIn = (
    <Link
      to={withNext('/signin', next)}
      className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
    >
      Back to sign in
    </Link>
  );

  if (invalid && !isInviteDestination(next)) {
    return (
      <AuthShell title="Sign in to Sorted" subtitle="This link is not valid." footer={backToSignIn}>
        <Link to="/signin" className={PRIMARY_LINK_CLASS}>
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  // An invite link that is malformed or expired gets the same invite recovery.
  if (invalid || phase === 'expired') {
    return <ExpiredLinkView next={next} footer={backToSignIn} />;
  }

  return (
    <AuthShell
      title="Sign in to Sorted"
      subtitle="Tap the button to finish signing in on this device."
      footer={backToSignIn}
    >
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={handleSignIn}
        disabled={phase === 'signing'}
      >
        {phase === 'signing' ? 'Signing in' : 'Sign in'}
      </Button>
    </AuthShell>
  );
}
