import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { CodeStep, RESEND_COOLDOWN_SECONDS } from '@/components/auth/CodeStep';
import { guestDestination } from '@/components/auth/RouteGuards';
import { TestSiteStart } from '@/components/test-site/TestSiteStart';
import { isTestSite, startTestSession } from '@/lib/test-site';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { isValidInviteEmail } from '@/components/pages/settings/MembersInviteForm';
import { CHECK_EMAIL_COPY, fillCopy } from '@/lib/induction-copy';
import { entryCopyContext } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';
import { prefetchShellWhenIdle } from '@/lib/chunk-reload';
import { deviceTimeZone } from '@/lib/time';

/** Seconds before Resend code can be tapped again; lives with CodeStep. */
export { RESEND_COOLDOWN_SECONDS };

/** Runtime-detected IANA timezone, stored for the workspace step. */
function detectTimezone(): string {
  return deviceTimeZone();
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
  /** Catch-up emails; onboarding reads it back from user_metadata. Absent = true. */
  emailOptIn?: boolean;
}

export type SignUpResult = { status: 'error'; message: string } | { status: 'sent' };

export const POLICY_CONSENT_MESSAGE = 'Tick the box to agree to the Terms and Privacy Policy.';

/** Alias of CHECK_EMAIL_COPY.rateLimited, kept for callers and tests. */
export const RATE_LIMIT_MESSAGE = CHECK_EMAIL_COPY.rateLimited;

/** Supabase answers 429 (or 403 on some limits) when codes are asked for too often. */
export function isRateLimitError(error: { message: string; status?: number | undefined }): boolean {
  if (error.status === 429 || error.status === 403) return true;
  return /rate limit|security purposes/i.test(error.message);
}

/** A code request's refusal in plain words: never the provider's raw text. */
export function linkErrorMessage(error: { message: string; status?: number | undefined }): string {
  return isRateLimitError(error) ? RATE_LIMIT_MESSAGE : CHECK_EMAIL_COPY.genericError;
}

/** The inline line for an email field that lost focus: null while empty or well formed. */
export function emailFieldError(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed === '' || isValidInviteEmail(trimmed)) return null;
  return CHECK_EMAIL_COPY.invalidEmail;
}

/**
 * Passwordless sign-up: email a 6-digit code that creates the account. Name,
 * username, role and the workspace come one question at a time in onboarding
 * (OnboardingFlow), which the app shell shows to anyone whose profile is
 * unfinished or who has no workspace. emailRedirectTo is the origin only, as
 * on sign in, so an old link email still returns to the right site.
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
      data: { timezone: input.timezone, email_opt_in: input.emailOptIn ?? true },
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) {
    return { status: 'error', message: linkErrorMessage(error) };
  }
  return { status: 'sent' };
}

const client = supabase as unknown as SignUpAuthClient;

/** The test site's sign-up refusals, in words. */
export function testSignUpMessage(code: string): string {
  if (code.includes('account_exists')) {
    return 'That email already has a real account. Use another email to test.';
  }
  if (code.includes('invalid_email')) return 'Enter a valid email address.';
  if (code.includes('rate_limited')) return 'Too many test accounts this hour. Try again later.';
  return "Couldn't start that. Try again.";
}

export function SignUpPage(): ReactElement {
  // After first paint, when idle: warm the shell and Pipeline chunks (code only).
  useEffect(() => prefetchShellWhenIdle(), []);
  const navigate = useNavigate();
  // The homepage signup band and the sign-in screen hand off ?email=; prefilled, still editable.
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [policyConsent, setPolicyConsent] = useState(false);
  // Ticked by default; never required to continue.
  const [emailOptIn, setEmailOptIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Checked when the field loses focus, and again on Create.
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  // Never disabled for the consent box: an unticked tap says why instead.
  const canSubmit = email.trim().length > 0 && !submitting;

  /** One request per call; the caller decides when (a tap), never a retry loop. */
  async function requestCode(): Promise<string | null> {
    const result = await performSignUp(client, {
      email,
      timezone: detectTimezone(),
      policyConsent,
      emailOptIn,
    });
    return result.status === 'error' ? result.message : null;
  }

  async function sendCode(): Promise<boolean> {
    setError(null);
    setSubmitting(true);
    const failure = await requestCode();
    setSubmitting(false);
    if (failure !== null) {
      setError(failure);
      return false;
    }
    return true;
  }

  async function handleSignUp(): Promise<void> {
    const badEmail = emailFieldError(email);
    setEmailError(badEmail);
    if (badEmail !== null) return;
    if (!policyConsent) {
      setError(POLICY_CONSENT_MESSAGE);
      return;
    }
    if (isTestSite()) {
      await testSignUp();
      return;
    }
    if (await sendCode()) setSent(true);
  }

  /** Test site: the typed email signs in at once as a test account (no code). */
  async function testSignUp(): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      await startTestSession(email);
      navigate('/chat', { replace: true });
    } catch (err) {
      setSubmitting(false);
      setError(testSignUpMessage(err instanceof Error ? err.message : String(err)));
    }
  }

  /** Where the link callback lands a new account: /pipeline, where onboarding opens. */
  function handleSignedIn(): void {
    navigate(guestDestination(null, null), { replace: true });
  }

  function backToForm(): void {
    setError(null);
    setSent(false);
  }

  if (sent) {
    return (
      <AuthShell
        title={CHECK_EMAIL_COPY.codeTitle}
        subtitle={fillCopy(CHECK_EMAIL_COPY.sentTo, entryCopyContext({ email: email.trim() }))}
        footer={
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
          >
            Back to sign in
          </Link>
        }
      >
        <CodeStep
          email={email}
          onResend={requestCode}
          onDifferentEmail={backToForm}
          onSignedIn={handleSignedIn}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your free account"
      subtitle={CHECK_EMAIL_COPY.subtitle}
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
            aria-invalid={emailError !== null}
            aria-describedby={emailError !== null ? 'signup-email-error' : undefined}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError(null);
            }}
            onBlur={() => setEmailError(emailFieldError(email))}
          />
          {emailError !== null ? (
            <p id="signup-email-error" role="alert" className="mt-1.5 text-base text-bad">
              {emailError}
            </p>
          ) : null}
        </Field>

        <div className="flex flex-wrap items-center gap-x-1 text-base text-fg-2">
          <label
            htmlFor="signup-email-opt-in"
            className="flex min-h-11 cursor-pointer items-center gap-3"
          >
            <input
              id="signup-email-opt-in"
              type="checkbox"
              checked={emailOptIn}
              onChange={(event) => setEmailOptIn(event.target.checked)}
              className="m-0 h-4 w-4 shrink-0 accent-accent"
            />
            <span>Email me updates I miss</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-1 text-base text-fg-2">
          <label
            htmlFor="signup-policy-consent"
            className="flex min-h-11 cursor-pointer items-center gap-3"
          >
            <input
              id="signup-policy-consent"
              type="checkbox"
              checked={policyConsent}
              onChange={(event) => {
                setPolicyConsent(event.target.checked);
                if (event.target.checked && error === POLICY_CONSENT_MESSAGE) setError(null);
              }}
              aria-label="Agree to the Terms and Privacy Policy"
              className="m-0 h-4 w-4 shrink-0 accent-accent"
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
          <p role="alert" className="text-base text-bad">
            {error}
          </p>
        ) : null}

        <Button variant="primary" className="w-full" type="submit" disabled={!canSubmit}>
          {submitting ? CHECK_EMAIL_COPY.sendingCode : CHECK_EMAIL_COPY.sendCode}
        </Button>
      </form>
    </AuthShell>
  );
}
