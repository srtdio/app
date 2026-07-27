import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { EmailOtpType } from '@supabase/supabase-js';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
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
    navigate('/pipeline', { replace: true });
  }

  const backToSignIn = (
    <Link
      to="/signin"
      className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
    >
      Back to sign in
    </Link>
  );

  if (invalid) {
    return (
      <AuthShell title="Sign in to Sorted" subtitle="This link is not valid." footer={backToSignIn}>
        <Link
          to="/signin"
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  if (phase === 'expired') {
    return (
      <AuthShell title="Sign in to Sorted" subtitle="This link has expired." footer={backToSignIn}>
        <Link
          to="/signin"
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Back to sign in
        </Link>
      </AuthShell>
    );
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
