import { useEffect, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { TestSiteStart } from '@/components/test-site/TestSiteStart';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { CHECK_EMAIL_COPY, fillCopy } from '@/lib/induction-copy';
import { entryCopyContext } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';

/** Seconds before Resend link can be tapped again. */
export const RESEND_COOLDOWN_SECONDS = 60;

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
    signInWithOtp(params: {
      email: string;
      options?: {
        shouldCreateUser?: boolean;
        data?: Record<string, unknown>;
        emailRedirectTo?: string;
      };
    }): Promise<{ error: { message: string; status?: number } | null }>;
  };
}

export interface SignUpInput {
  email: string;
  timezone: string;
  policyConsent: boolean;
}

export type SignUpResult = { status: 'error'; message: string } | { status: 'sent' };

export const POLICY_CONSENT_MESSAGE = 'Tick the box to agree to the Terms and Privacy Policy.';

/** Alias of CHECK_EMAIL_COPY.rateLimited, kept for callers and tests. */
export const RATE_LIMIT_MESSAGE = CHECK_EMAIL_COPY.rateLimited;

/** Supabase answers 429 (or 403 on some limits) when links are asked for too often. */
export function isRateLimitError(error: { message: string; status?: number }): boolean {
  if (error.status === 429 || error.status === 403) return true;
  return /rate limit|security purposes/i.test(error.message);
}

/**
 * Passwordless sign-up: email a sign-in link that creates the account. Name,
 * username, role and the workspace come one question at a time in onboarding
 * (OnboardingFlow), which the app shell shows to anyone whose profile is
 * unfinished or who has no workspace. emailRedirectTo is the origin only, as
 * on sign in: the email template appends our own /auth/callback path.
 */
export async function performSignUp(
  client: SignUpAuthClient,
  input: SignUpInput,
): Promise<SignUpResult> {
  if (!input.policyConsent) return { status: 'error', message: POLICY_CONSENT_MESSAGE };

  const { error } = await client.auth.signInWithOtp({
    email: input.email.trim(),
    options: {
      shouldCreateUser: true,
      data: { timezone: input.timezone },
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) {
    return {
      status: 'error',
      message: isRateLimitError(error) ? RATE_LIMIT_MESSAGE : error.message,
    };
  }
  return { status: 'sent' };
}

/** Counts down once a second to zero; the timer is cleared on every change and unmount. */
function useCooldown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  return [left, setLeft];
}

const client = supabase as unknown as SignUpAuthClient;

export function SignUpPage(): ReactElement {
  // The homepage signup band and the sign-in screen hand off ?email=; prefilled, still editable.
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [policyConsent, setPolicyConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, startCooldown] = useCooldown();

  const canSubmit = email.trim().length > 0 && policyConsent && !submitting;

  /** One request per call; the caller decides when (a tap), never a retry loop. */
  async function sendLink(): Promise<boolean> {
    setError(null);
    setSubmitting(true);
    const result = await performSignUp(client, {
      email,
      timezone: detectTimezone(),
      policyConsent,
    });
    setSubmitting(false);
    if (result.status === 'error') {
      setError(result.message);
      return false;
    }
    startCooldown(RESEND_COOLDOWN_SECONDS);
    return true;
  }

  async function handleSignUp(): Promise<void> {
    if (await sendLink()) setSent(true);
  }

  function handleResend(): void {
    if (cooldown > 0 || submitting) return;
    void sendLink();
  }

  function backToForm(): void {
    setError(null);
    setSent(false);
  }

  if (sent) {
    return (
      <AuthShell
        title={CHECK_EMAIL_COPY.title}
        subtitle={fillCopy(CHECK_EMAIL_COPY.body, entryCopyContext({ email: email.trim() }))}
        footer={
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
          >
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col gap-3">
          {error !== null ? (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          ) : null}
          <Button
            variant="default"
            size="lg"
            className="w-full"
            onClick={handleResend}
            disabled={cooldown > 0 || submitting}
          >
            {cooldown > 0 ? `${CHECK_EMAIL_COPY.resend} (${cooldown}s)` : CHECK_EMAIL_COPY.resend}
          </Button>
          <button
            type="button"
            onClick={backToForm}
            className="inline-flex min-h-[44px] w-full items-center justify-center text-sm font-medium text-accent hover:underline"
          >
            {CHECK_EMAIL_COPY.differentEmail}
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your free account"
      subtitle={CHECK_EMAIL_COPY.signUpSubtitle}
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
      <TestSiteStart />
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
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-x-1 text-sm text-fg-2">
          <label
            htmlFor="signup-policy-consent"
            className="flex min-h-11 cursor-pointer items-center gap-2"
          >
            <input
              id="signup-policy-consent"
              type="checkbox"
              checked={policyConsent}
              onChange={(event) => setPolicyConsent(event.target.checked)}
              aria-label="Agree to the Terms and Privacy Policy"
              className="h-4 w-4 shrink-0 accent-accent"
            />
            <span>I agree to the</span>
          </label>
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
        </div>

        {error !== null ? (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        ) : null}

        <Button variant="primary" size="lg" className="w-full" type="submit" disabled={!canSubmit}>
          {submitting ? CHECK_EMAIL_COPY.sending : CHECK_EMAIL_COPY.createAccount}
        </Button>
      </form>
    </AuthShell>
  );
}
