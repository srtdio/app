import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { TestSiteStart } from '@/components/test-site/TestSiteStart';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { emailFieldError, linkErrorMessage } from '@/components/auth/SignUpPage';
import { CHECK_EMAIL_COPY } from '@/lib/induction-copy';
import { supabase } from '@/lib/supabase';

const RESEND_COOLDOWN_SECONDS = 60;

/** localStorage key holding the ?next= destination while a magic link is in flight. */
export const NEXT_STORAGE_KEY = 'srtd.auth.next';

/**
 * Open-redirect guard for ?next=. Only an in-app path is allowed: it must start
 * with a single '/', never '//' (protocol-relative), never a backslash (browsers
 * read a leading slash plus backslash as '//') and never a control or whitespace
 * character (browsers strip tabs and newlines, so a slash, tab, slash prefix
 * would become '//').
 * Anything else, absolute URLs included, returns '' (no destination).
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return '';
  return raw;
}

/** A path with a safe destination appended as ?next=; the path alone when there is none. */
export function withNext(path: string, next: string): string {
  const safe = safeNextPath(next);
  return safe === '' ? path : `${path}?next=${encodeURIComponent(safe)}`;
}

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

/** RequireAuth hands the blocked location over as router state { from }. */
function stateFrom(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('from' in state)) return '';
  const from = (state as { from: unknown }).from;
  return typeof from === 'string' ? from : '';
}

/** The sign-in destination: a safe ?next= first, then RequireAuth's { from } state. */
export function resolveNext(queryNext: string | null, state: unknown): string {
  return safeNextPath(queryNext) || safeNextPath(stateFrom(state));
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
  | { status: 'error'; message: string; httpStatus?: number };

/** Supabase answers this when an email link is asked for an email with no account. */
function isNoAccountError(message: string): boolean {
  return /signups not allowed|user not found/i.test(message);
}

/**
 * Email an existing user a sign-in link; never creates a user. emailRedirectTo
 * is the current origin (no path) so the template's {{ .RedirectTo }} sends the
 * link back to the site it was requested from. The template still appends our
 * own /auth/callback path, never Supabase's verify endpoint. A non-allowlisted
 * origin falls back to the project Site URL.
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
export function signInErrorMessage(result: { message: string; httpStatus?: number }): string {
  return linkErrorMessage({ message: result.message, status: result.httpStatus });
}

export function SignInPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const next = resolveNext(searchParams.get('next'), location.state);
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

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
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  async function handleResend(): Promise<void> {
    if (cooldown > 0) return;
    setError(null);
    rememberNext(next);
    const result = await sendSignInLink(client, email);
    if (result.status === 'error') {
      setError(signInErrorMessage(result));
      return;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
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
        title="Check your email"
        subtitle={`We sent a sign-in link to ${email}. Open it on this device.`}
        footer={footer}
      >
        <div className="flex flex-col gap-4">
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
            disabled={cooldown > 0}
          >
            {cooldown > 0 ? `Send again in ${cooldown}s` : 'Send again'}
          </Button>
          <button
            type="button"
            onClick={startOverWithNewEmail}
            className="inline-flex min-h-[44px] w-full items-center justify-center text-sm font-medium text-accent hover:underline"
          >
            {CHECK_EMAIL_COPY.differentEmail}
          </button>
        </div>
      </AuthShell>
    );
  }

  const busy = submitting;

  return (
    <AuthShell
      title="Sign in"
      subtitle="We email you a link. Open it to sign in, no password needed."
      footer={footer}
    >
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
            <p id="signin-email-error" role="alert" className="mt-1.5 text-sm text-bad">
              {emailError}
            </p>
          ) : null}
        </Field>

        {noAccount ? (
          <div
            role="status"
            className="flex flex-col gap-3 rounded-md bg-warn-soft p-3 text-sm text-fg"
          >
            <span>There is no account with this email yet.</span>
            <Link
              to={`/signup?email=${encodeURIComponent(email.trim())}`}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-fg px-4 text-sm font-medium text-bg hover:opacity-90"
            >
              Create one with this email
            </Link>
          </div>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          type="submit"
          className="w-full"
          disabled={busy || email.trim().length === 0}
        >
          {busy ? 'Sending link' : 'Email me a sign-in link'}
        </Button>
      </form>
    </AuthShell>
  );
}
