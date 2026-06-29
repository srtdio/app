import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;

/**
 * The minimal slice of the Supabase auth client the OTP helpers need, so tests
 * can mock it without constructing a full client (mirrors SignUpAuthClient).
 */
export interface SignInAuthClient {
  auth: {
    signInWithOtp(params: {
      email: string;
      options?: { shouldCreateUser?: boolean; emailRedirectTo?: string };
    }): Promise<{ error: { message: string } | null }>;
    verifyOtp(params: {
      email: string;
      token: string;
      type: 'email';
    }): Promise<{ error: { message: string } | null }>;
  };
}

export type SendCodeResult = { status: 'sent' } | { status: 'error'; message: string };
export type VerifyCodeResult = { status: 'authenticated' } | { status: 'error'; message: string };

/** Request a 6-digit sign-in code for an existing user; never creates one. */
export async function sendOtpCode(
  client: SignInAuthClient,
  email: string,
  redirectTo: string,
): Promise<SendCodeResult> {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
  });
  if (error) return { status: 'error', message: error.message };
  return { status: 'sent' };
}

/** Exchange the emailed code for a session. */
export async function verifyOtpCode(
  client: SignInAuthClient,
  email: string,
  token: string,
): Promise<VerifyCodeResult> {
  const { error } = await client.auth.verifyOtp({ email, token, type: 'email' });
  if (error) return { status: 'error', message: error.message };
  return { status: 'authenticated' };
}

/**
 * Honor location.state.from only when it is a same-origin path (single leading
 * slash); reject protocol-relative "//evil" and non-strings. Default /pipeline.
 */
export function resolveDestination(from: unknown): string {
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
    ? from
    : '/pipeline';
}

/**
 * Six segmented numeric cells. Typing auto-advances; Backspace on an empty cell
 * steps back; pasting or OS one-time-code autofill into the first cell spreads
 * the digits across every cell.
 */
function CodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? '');

  function setCell(index: number, raw: string): void {
    const cleaned = raw.replace(/\D/g, '');
    if (cleaned.length === 0 && digits[index] === '') return;
    if (cleaned.length > 1) {
      const next = (value.slice(0, index) + cleaned).replace(/\D/g, '').slice(0, CODE_LENGTH);
      onChange(next);
      refs.current[Math.min(next.length, CODE_LENGTH - 1)]?.focus();
      return;
    }
    const chars = digits.slice();
    chars[index] = cleaned;
    onChange(chars.join('').slice(0, CODE_LENGTH));
    if (cleaned.length === 1 && index < CODE_LENGTH - 1) refs.current[index + 1]?.focus();
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Backspace' && digits[index] === '' && index > 0) {
      event.preventDefault();
      refs.current[index - 1]?.focus();
    }
  }

  return (
    <div className="flex justify-between gap-2">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          id={index === 0 ? 'signin-code' : undefined}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${index + 1}`}
          value={digit}
          disabled={disabled}
          onChange={(event) => setCell(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          className="h-14 min-w-[44px] flex-1 rounded-md border border-border bg-panel-2 text-center font-mono text-lg text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft disabled:opacity-50"
        />
      ))}
    </div>
  );
}

const client = supabase as unknown as SignInAuthClient;

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  function redirectTo(): string {
    return `${window.location.origin}/`;
  }

  async function handleSend(): Promise<void> {
    setError(null);
    setSubmitting(true);
    const result = await sendOtpCode(client, email, redirectTo());
    if (result.status === 'error') {
      setError(result.message);
      setSubmitting(false);
      return;
    }
    setCode('');
    setStep('code');
    setCooldown(RESEND_COOLDOWN_SECONDS);
    setSubmitting(false);
  }

  async function handleResend(): Promise<void> {
    if (cooldown > 0) return;
    setError(null);
    const result = await sendOtpCode(client, email, redirectTo());
    if (result.status === 'error') {
      setError(result.message);
      return;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  async function handleVerify(): Promise<void> {
    setError(null);
    setSubmitting(true);
    const result = await verifyOtpCode(client, email, code);
    if (result.status === 'error') {
      setError(result.message);
      setSubmitting(false);
      return;
    }
    navigate(resolveDestination((location.state as { from?: unknown } | null)?.from), {
      replace: true,
    });
  }

  function useDifferentEmail(): void {
    setError(null);
    setCode('');
    setStep('email');
  }

  const footer = (
    <Link
      to="/signup"
      className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
    >
      Create an account
    </Link>
  );

  if (step === 'code') {
    return (
      <AuthShell
        title="Check your email"
        subtitle={`Enter the 6-digit code sent to ${email}.`}
        footer={footer}
      >
        <div className="flex flex-col gap-4">
          <Field label="Verification code" htmlFor="signin-code">
            <CodeInput value={code} onChange={setCode} disabled={submitting} />
          </Field>

          {error !== null ? <p className="text-sm text-bad">{error}</p> : null}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleVerify}
            disabled={submitting || code.length < CODE_LENGTH}
          >
            {submitting ? 'Verifying' : 'Verify and sign in'}
          </Button>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={useDifferentEmail}
              className="inline-flex min-h-[44px] items-center text-sm text-fg-2 hover:text-fg"
            >
              Use a different email
            </button>
            <button
              type="button"
              onClick={handleResend}
              disabled={cooldown > 0}
              className="inline-flex min-h-[44px] items-center text-sm text-accent hover:underline disabled:text-fg-3 disabled:no-underline"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
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
          {submitting ? 'Sending code' : 'Send code'}
        </Button>
      </div>
    </AuthShell>
  );
}
