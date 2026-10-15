import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

export const MIN_PASSWORD_LENGTH = 8;

/** Runtime-detected IANA timezone, stored for the workspace step. */
function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

/**
 * The minimal slice of the Supabase auth client performSignUp needs, so tests
 * can mock it without constructing a full client.
 */
export interface SignUpAuthClient {
  auth: {
    signUp(credentials: {
      email: string;
      password: string;
      options?: { data?: Record<string, unknown> };
    }): Promise<{ data: { session: Session | null }; error: { message: string } | null }>;
  };
}

export interface SignUpInput {
  email: string;
  password: string;
  timezone: string;
  policyConsent: boolean;
}

export type SignUpResult =
  | { status: 'error'; message: string }
  | { status: 'authenticated' }
  | { status: 'confirm-email' };

export const POLICY_CONSENT_MESSAGE = 'Tick the box to agree to the Terms and Privacy Policy.';

/**
 * Create the account with email and password only. Name, username, role and the
 * workspace come one question at a time in onboarding (OnboardingFlow), which the
 * app shell shows to anyone whose profile is unfinished or who has no workspace.
 */
export async function performSignUp(
  client: SignUpAuthClient,
  input: SignUpInput,
): Promise<SignUpResult> {
  if (!input.policyConsent) return { status: 'error', message: POLICY_CONSENT_MESSAGE };

  const { data, error } = await client.auth.signUp({
    email: input.email.trim(),
    password: input.password,
    options: { data: { timezone: input.timezone } },
  });
  if (error) return { status: 'error', message: error.message };
  if (data.session === null) return { status: 'confirm-email' };
  return { status: 'authenticated' };
}

export function SignUpPage() {
  const navigate = useNavigate();
  // The homepage signup band and the sign-in screen hand off ?email=; prefilled, still editable.
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [policyConsent, setPolicyConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  const canSubmit =
    email.trim().length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    policyConsent &&
    !submitting;

  async function handleSignUp(): Promise<void> {
    setError(null);
    setSubmitting(true);
    const result = await performSignUp(supabase as unknown as SignUpAuthClient, {
      email,
      password,
      timezone: detectTimezone(),
      policyConsent,
    });
    if (result.status === 'error') {
      setError(result.message);
      setSubmitting(false);
      return;
    }
    if (result.status === 'confirm-email') {
      setAwaitingConfirm(true);
      setSubmitting(false);
      return;
    }
    navigate('/chat', { replace: true });
  }

  if (awaitingConfirm) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="One more step to finish setting up."
        footer={
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
          >
            Back to sign in
          </Link>
        }
      >
        <p className="text-sm text-fg-2 [text-wrap:pretty]">
          We sent a confirmation link to <span className="font-medium text-fg">{email}</span>. Open
          it, then sign in to set up your workspace.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your free account"
      subtitle="No card needed. Takes about a minute."
      footer={
        <span className="inline-flex flex-wrap items-center justify-center gap-x-1">
          <span>Already have an account?</span>
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] items-center justify-center font-medium text-accent hover:underline"
          >
            Sign in
          </Link>
        </span>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void handleSignUp();
        }}
      >
        <Field label="Work email" htmlFor="signup-email">
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            placeholder="you@agency.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="signup-password" hint="At least 8 characters.">
          <div className="relative">
            <Input
              id="signup-password"
              type={passwordVisible ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              className="pr-16"
            />
            <button
              type="button"
              aria-label={passwordVisible ? 'Hide password' : 'Show password'}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((visible) => !visible)}
              className="absolute right-0 top-0 min-h-[44px] min-w-[44px] px-3 text-xs font-medium text-accent hover:underline"
            >
              {passwordVisible ? 'Hide' : 'Show'}
            </button>
          </div>
        </Field>

        <div className="flex items-start gap-1.5 text-sm text-fg-2">
          <label
            htmlFor="signup-policy-consent"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
          >
            <input
              id="signup-policy-consent"
              type="checkbox"
              checked={policyConsent}
              onChange={(event) => setPolicyConsent(event.target.checked)}
              aria-label="Agree to the Terms and Privacy Policy"
              className="h-4 w-4 accent-accent"
            />
          </label>
          <span className="flex flex-wrap items-center gap-x-1 leading-6">
            <span className="flex min-h-11 items-center">I agree to the</span>
            <Link
              to="/legal/terms-and-conditions"
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center text-accent underline underline-offset-2"
            >
              Terms
            </Link>
            <span className="flex min-h-11 items-center">and</span>
            <Link
              to="/legal/privacy-policy"
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center text-accent underline underline-offset-2"
            >
              Privacy Policy
            </Link>
          </span>
        </div>

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          className="w-full bg-fg text-bg hover:bg-fg hover:opacity-90"
          type="submit"
          disabled={!canSubmit}
        >
          {submitting ? 'Creating account' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
