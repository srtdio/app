import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

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
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [timezone, setTimezone] = useState(detectTimezone);
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
      <div className="flex flex-col gap-4">
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

        <Field label="Password" htmlFor="signup-password">
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
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

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={handleSignUp}
          disabled={submitting}
        >
          {submitting ? 'Creating account' : 'Create account'}
        </Button>
      </div>
    </AuthShell>
  );
}
