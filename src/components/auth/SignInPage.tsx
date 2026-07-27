import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * The minimal slice of the Supabase auth client the sign-in helper needs, so
 * tests can mock it without constructing a full client (mirrors SignUpAuthClient).
 */
export interface SignInAuthClient {
  auth: {
    signInWithOtp(params: {
      email: string;
      options?: { shouldCreateUser?: boolean };
    }): Promise<{ error: { message: string } | null }>;
  };
}

export type SendLinkResult = { status: 'sent' } | { status: 'error'; message: string };

/**
 * Email an existing user a sign-in link; never creates a user. emailRedirectTo
 * is intentionally omitted: the link URL is built by the email template so it
 * points at our own callback page, not at Supabase's verify endpoint.
 */
export async function sendSignInLink(
  client: SignInAuthClient,
  email: string,
): Promise<SendLinkResult> {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) return { status: 'error', message: error.message };
  return { status: 'sent' };
}

const client = supabase as unknown as SignInAuthClient;

export function SignInPage() {
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  async function handleSend(): Promise<void> {
    setError(null);
    setSubmitting(true);
    const result = await sendSignInLink(client, email);
    setSubmitting(false);
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
    const result = await sendSignInLink(client, email);
    if (result.status === 'error') {
      setError(result.message);
      return;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  const footer = (
    <Link
      to="/signup"
      className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
    >
      Create an account
    </Link>
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
            variant="primary"
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

  return (
    <AuthShell title="Sign in" subtitle="Welcome back to Sorted." footer={footer}>
      <div className="flex flex-col gap-4">
        <Field label="Email" htmlFor="signin-email">
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={handleSend}
          disabled={submitting || email.length === 0}
        >
          {submitting ? 'Sending link' : 'Email me a sign-in link'}
        </Button>
      </div>
    </AuthShell>
  );
}
