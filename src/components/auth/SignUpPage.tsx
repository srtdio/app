import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

const MIN_PASSWORD_LENGTH = 6;

/** Runtime-detected IANA timezone; shown prefilled and editable. */
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
  displayName: string;
  workspaceName: string;
  timezone: string;
  policyConsent: boolean;
}

export type SignUpResult =
  | { status: 'error'; message: string }
  | { status: 'authenticated' }
  | { status: 'confirm-email' };

/**
 * Sign the user up, stashing the workspace details as user_metadata. Workspace
 * creation is intentionally NOT performed here: with email confirmation ON,
 * signUp returns no session, so an RPC fired now would run unauthenticated and
 * silently create nothing. Creation is deferred to the first authenticated load
 * (WorkspaceProvider bootstrap), giving one creation path that works whether
 * confirmation is ON (session null -> confirm-email) or OFF (session present).
 */
export async function performSignUp(
  client: SignUpAuthClient,
  input: SignUpInput,
): Promise<SignUpResult> {
  if (!input.policyConsent) {
    return {
      status: 'error',
      message: 'You must agree to the Privacy Policy and Terms & Conditions to create an account.',
    };
  }

  const { data, error } = await client.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: {
        display_name: input.displayName,
        workspace_name: input.workspaceName,
        timezone: input.timezone,
      },
    },
  });
  if (error) return { status: 'error', message: error.message };
  if (data.session === null) return { status: 'confirm-email' };
  return { status: 'authenticated' };
}

export function SignUpPage() {
  const navigate = useNavigate();
  // The homepage signup band hands off ?email=; prefill it, still editable.
  const [searchParams] = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [timezone, setTimezone] = useState(detectTimezone);
  const [policyConsent, setPolicyConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  async function handleSignUp(): Promise<void> {
    setError(null);
    setSubmitting(true);

    const result = await performSignUp(supabase as unknown as SignUpAuthClient, {
      email,
      password,
      displayName: name,
      workspaceName,
      timezone,
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
    navigate('/pipeline', { replace: true });
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
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">
            Check your email to confirm your account. We sent a confirmation link to{' '}
            <span className="font-medium text-fg">{email}</span>. Once confirmed, sign in and your
            workspace will be ready.
          </p>
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] min-w-[44px] w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Set up your workspace on Sorted."
      footer={
        <Link
          to="/signin"
          className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
        >
          Sign in
        </Link>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSignUp();
        }}
      >
        <Field label="Name" htmlFor="signup-name">
          <Input
            id="signup-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Email" htmlFor="signup-email">
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="signup-password" required>
          <div className="relative">
            <Input
              id="signup-password"
              type={passwordVisible ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby="signup-password-hint"
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
          <p id="signup-password-hint" className="mt-1.5 text-[11px] text-fg-3">
            Use at least {MIN_PASSWORD_LENGTH} characters that contains letters, numbers and
            symbols.
          </p>
        </Field>

        <Field label="Workspace name" htmlFor="signup-workspace">
          <Input
            id="signup-workspace"
            type="text"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
        </Field>

        <Field
          label="Workspace timezone"
          htmlFor="signup-timezone"
          hint="Detected automatically. Edit if it looks wrong."
        >
          <Input
            id="signup-timezone"
            type="text"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </Field>

        <div className="flex items-start gap-1.5 text-sm text-fg-2">
          <label
            htmlFor="signup-policy-consent"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
          >
            <input
              id="signup-policy-consent"
              type="checkbox"
              required
              checked={policyConsent}
              onChange={(event) => setPolicyConsent(event.target.checked)}
              aria-label="Agree to the Privacy Policy and Terms & Conditions"
              className="h-4 w-4 accent-accent"
            />
          </label>
          <span className="flex flex-wrap items-center gap-x-1 leading-6">
            <span className="flex min-h-11 items-center">I have read and agree to the</span>
            <Link
              to="/legal/privacy-policy"
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center text-accent underline underline-offset-2"
            >
              Privacy Policy
            </Link>
            ,
            <Link
              to="/legal/terms-and-conditions"
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center text-accent underline underline-offset-2"
            >
              Terms &amp; Conditions
            </Link>
          </span>
        </div>

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          type="submit"
          disabled={submitting || !policyConsent}
        >
          {submitting ? 'Creating account' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
