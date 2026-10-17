import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

const RESEND_COOLDOWN_SECONDS = 60;

/** Where a signed-in user lands when no safe ?next= destination was given. */
export const DEFAULT_AFTER_SIGN_IN = '/chat';

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
    }): Promise<{ error: { message: string } | null }>;
    signInWithPassword?(params: {
      email: string;
      password: string;
    }): Promise<{ error: { message: string } | null }>;
  };
}

export type SendLinkResult =
  | { status: 'sent' }
  | { status: 'no-account' }
  | { status: 'error'; message: string };

export type PasswordSignInResult =
  | { status: 'signed-in' }
  | { status: 'wrong' }
  | { status: 'error'; message: string };

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
      : { status: 'error', message: error.message };
  }
  return { status: 'sent' };
}

/** Email and password sign-in. A bad pair reads as one plain message, never which part. */
export async function signInWithPassword(
  client: SignInAuthClient,
  email: string,
  password: string,
): Promise<PasswordSignInResult> {
  const signIn = client.auth.signInWithPassword;
  if (signIn === undefined) return { status: 'error', message: 'Password sign-in unavailable.' };
  const { error } = await signIn.call(client.auth, { email: email.trim(), password });
  if (error) {
    return /invalid login credentials/i.test(error.message)
      ? { status: 'wrong' }
      : { status: 'error', message: error.message };
  }
  return { status: 'signed-in' };
}

const client = supabase as unknown as SignInAuthClient;

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const next = resolveNext(searchParams.get('next'), location.state);
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [submitting, setSubmitting] = useState<'password' | 'link' | null>(null);
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

  async function handlePassword(): Promise<void> {
    reset();
    setSubmitting('password');
    const result = await signInWithPassword(client, email, password);
    setSubmitting(null);
    if (result.status === 'wrong') {
      setError('That email and password do not match. Try again, or email yourself a link.');
      return;
    }
    if (result.status === 'error') {
      setError(result.message);
      return;
    }
    navigate(next || DEFAULT_AFTER_SIGN_IN, { replace: true });
  }

  async function handleSend(): Promise<void> {
    reset();
    setSubmitting('link');
    rememberNext(next);
    const result = await sendSignInLink(client, email);
    setSubmitting(null);
    if (result.status === 'no-account') {
      setNoAccount(true);
      return;
    }
    if (result.status === 'error') {
      setError(result.message);
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
      setError(result.message);
      return;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
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
          {error !== null ? <p className="text-sm text-bad">{error}</p> : null}
          <Button
            variant="default"
            size="lg"
            className="w-full"
            onClick={handleResend}
            disabled={cooldown > 0}
          >
            {cooldown > 0 ? `Send again in ${cooldown}s` : 'Send again'}
          </Button>
        </div>
      </AuthShell>
    );
  }

  const busy = submitting !== null;

  return (
    <AuthShell title="Sign in" subtitle="Welcome back to Sorted." footer={footer}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && email.length > 0 && password.length > 0) void handlePassword();
        }}
      >
        <Field label="Email" htmlFor="signin-email">
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              reset();
            }}
          />
        </Field>

        <Field label="Password" htmlFor="signin-password">
          <Input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
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

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          type="submit"
          className="w-full bg-fg text-bg hover:bg-fg hover:opacity-90"
          disabled={busy || email.length === 0 || password.length === 0}
        >
          {submitting === 'password' ? 'Signing in' : 'Sign in'}
        </Button>

        <Button
          variant="default"
          size="lg"
          type="button"
          className="w-full"
          onClick={() => void handleSend()}
          disabled={busy || email.length === 0}
        >
          {submitting === 'link' ? 'Sending link' : 'Email me a sign-in link instead'}
        </Button>
      </form>
    </AuthShell>
  );
}
