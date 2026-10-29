import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { CodeStep } from '@/components/auth/CodeStep';
import { guestDestination } from '@/components/auth/RouteGuards';
import { TestSiteStart } from '@/components/test-site/TestSiteStart';
import { Button, buttonClass } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { emailFieldError, linkErrorMessage } from '@/components/auth/SignUpPage';
import { CHECK_EMAIL_COPY, fillCopy } from '@/lib/induction-copy';
import { entryCopyContext } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';
import { prefetchShellWhenIdle } from '@/lib/chunk-reload';
import { resolveNext, safeNextPath } from '@/components/auth/next-param';

/** localStorage key holding the ?next= destination while a code (or an old link) is in flight. */
export const NEXT_STORAGE_KEY = 'srtd.auth.next';

/** The slice of Storage the next helpers use, so tests pass a plain fake. */
export interface NextStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const NOOP_STORE: NextStore = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/** localStorage, or a no-op store when the browser blocks it (private mode, previews). */
function browserStore(): NextStore {
  try {
    return typeof window === 'undefined' || !window.localStorage ? NOOP_STORE : window.localStorage;
  } catch {
    return NOOP_STORE;
  }
}

/**
 * Keep the destination on this device while the magic link is in flight. The
 * email template appends /auth/callback to emailRedirectTo, so the link itself
 * cannot carry ?next=; the callback reads it back from here instead. A request
 * with no destination clears any stale one.
 */
export function rememberNext(next: string, store: NextStore = browserStore()): void {
  const safe = safeNextPath(next);
  try {
    if (safe === '') store.removeItem(NEXT_STORAGE_KEY);
    else store.setItem(NEXT_STORAGE_KEY, safe);
  } catch {
    // Storage can throw (quota, blocked); the default landing still works.
  }
}

/** The remembered destination, re-validated; '' when none or storage is unavailable. */
export function readRememberedNext(store: NextStore = browserStore()): string {
  try {
    return safeNextPath(store.getItem(NEXT_STORAGE_KEY));
  } catch {
    return '';
  }
}

/** Drop the remembered destination once it has been used. */
export function forgetNext(store: NextStore = browserStore()): void {
  try {
    store.removeItem(NEXT_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/**
 * The minimal slice of the Supabase auth client the sign-in helpers need, so
 * tests can mock it without constructing a full client (mirrors SignUpAuthClient).
 */
export interface SignInAuthClient {
  auth: {
    signInWithOtp(params: {
      email: string;
      options?: { shouldCreateUser?: boolean; emailRedirectTo?: string };
    }): Promise<{ error: { message: string; status?: number } | null }>;
  };
}

export type SendLinkResult =
  | { status: 'sent' }
  | { status: 'no-account' }
  | { status: 'error'; message: string; httpStatus?: number | undefined };

/** Supabase answers this when an email link is asked for an email with no account. */
function isNoAccountError(message: string): boolean {
  return /signups not allowed|user not found/i.test(message);
}

/**
 * Email an existing user a 6-digit sign-in code; never creates a user. The
 * templates carry {{ .Token }} only. emailRedirectTo stays the current origin
 * (no path) so a link email still pasted in the dashboard returns to the site it
 * was requested from; a non-allowlisted origin falls back to the Site URL.
 */
export async function sendSignInLink(
  client: SignInAuthClient,
  email: string,
): Promise<SendLinkResult> {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
  });
  if (error) {
    return isNoAccountError(error.message)
      ? { status: 'no-account' }
      : { status: 'error', message: error.message, httpStatus: error.status };
  }
  return { status: 'sent' };
}

const client = supabase as unknown as SignInAuthClient;

/** What the sign-in screen shows for a refused link: plain copy, never the raw text. */
export function signInErrorMessage(result: {
  message: string;
  httpStatus?: number | undefined;
}): string {
  return linkErrorMessage({ message: result.message, status: result.httpStatus });
}

export function SignInPage() {
  // After first paint, when idle: warm the shell and Pipeline chunks (code only).
  useEffect(() => prefetchShellWhenIdle(), []);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const next = resolveNext(searchParams.get('next'), location.state);
  const navigate = useNavigate();
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset(): void {
    setError(null);
    setNoAccount(false);
  }

  async function handleSend(): Promise<void> {
    reset();
    const badEmail = emailFieldError(email);
    setEmailError(badEmail);
    if (badEmail !== null) return;
    setSubmitting(true);
    rememberNext(next);
    const result = await sendSignInLink(client, email);
    setSubmitting(false);
    if (result.status === 'no-account') {
      setNoAccount(true);
      return;
    }
    if (result.status === 'error') {
      setError(signInErrorMessage(result));
      return;
    }
    setSent(true);
  }

  /** CodeStep's resend: the line to show on failure, null once sent. */
  async function handleResend(): Promise<string | null> {
    rememberNext(next);
    const result = await sendSignInLink(client, email);
    if (result.status === 'error') return signInErrorMessage(result);
    if (result.status === 'no-account') return CHECK_EMAIL_COPY.genericError;
    return null;
  }

  /** Where the link callback lands: the remembered ?next=, else /pipeline. */
  function handleSignedIn(): void {
    forgetNext();
    navigate(guestDestination(next, null), { replace: true });
  }

  /** Back to the form with the email kept, to fix a typo. */
  function startOverWithNewEmail(): void {
    setError(null);
    setSent(false);
  }

  const footer = (
    <span className="inline-flex flex-wrap items-center justify-center gap-x-1">
      <span>New to Sorted?</span>
      <Link
        to="/signup"
        className="inline-flex min-h-[44px] items-center justify-center font-medium text-accent hover:underline"
      >
        Sign up free
      </Link>
    </span>
  );

  if (sent) {
    return (
      <AuthShell
        title={CHECK_EMAIL_COPY.codeTitle}
        subtitle={fillCopy(CHECK_EMAIL_COPY.sentTo, entryCopyContext({ email: email.trim() }))}
        footer={footer}
      >
        <CodeStep
          email={email}
          onResend={handleResend}
          onDifferentEmail={startOverWithNewEmail}
          onSignedIn={handleSignedIn}
        />
      </AuthShell>
    );
  }

  const busy = submitting;

  return (
    <AuthShell title="Sign in" subtitle={CHECK_EMAIL_COPY.subtitle} footer={footer}>
      <TestSiteStart />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && email.trim().length > 0) void handleSend();
        }}
      >
        <Field label="Email" htmlFor="signin-email">
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={emailError !== null}
            aria-describedby={emailError !== null ? 'signin-email-error' : undefined}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError(null);
              reset();
            }}
            onBlur={() => setEmailError(emailFieldError(email))}
          />
          {emailError !== null ? (
            <p id="signin-email-error" role="alert" className="mt-1.5 text-base text-bad">
              {emailError}
            </p>
          ) : null}
        </Field>

        {noAccount ? (
          <div
            role="status"
            className="flex flex-col gap-3 rounded-lg bg-warn-soft p-3 text-base text-fg"
          >
            <span>There is no account with this email yet.</span>
            <Link
              to={`/signup?email=${encodeURIComponent(email.trim())}`}
              className={buttonClass('primary', 'default', 'w-full')}
            >
              Create one with this email
            </Link>
          </div>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-base text-bad">
            {error}
          </p>
        ) : null}

        <Button
          variant="primary"
          type="submit"
          className="w-full"
          disabled={busy || email.trim().length === 0}
        >
          {busy ? CHECK_EMAIL_COPY.sendingCode : CHECK_EMAIL_COPY.sendCode}
        </Button>
      </form>
    </AuthShell>
  );
}
