import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { CHECK_EMAIL_COPY } from '@/lib/induction-copy';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';

/** Digits in an email code; matches supabase/config.toml otp_length. */
export const CODE_LENGTH = 6;

/** Seconds before Resend code can be tapped again. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** A code's lifetime; matches supabase/config.toml otp_expiry. */
export const CODE_EXPIRY_MS = 3600 * 1000;

/**
 * The minimal slice of the Supabase auth client the code step needs, so tests
 * can mock it without constructing a full client.
 */
export interface CodeAuthClient {
  auth: {
    verifyOtp(params: {
      email: string;
      token: string;
      type: 'email';
    }): Promise<{ error: { message: string; code?: string; status?: number } | null }>;
  };
}

export type CodeErrorKind = 'wrong' | 'expired' | 'rate-limited';

export type VerifyCodeResult = { status: 'signed-in' } | { status: 'error'; kind: CodeErrorKind };

/**
 * A refused code by its error code, never the provider text. Supabase answers
 * otp_expired for a wrong code as well as an old one, so a code older than its
 * lifetime reads as expired and any other refusal as wrong.
 */
export function codeErrorKind(
  error: { code?: string | undefined; status?: number | undefined },
  sentAtMs: number,
  nowMs: number,
): CodeErrorKind {
  if (error.status === 429 || (error.code ?? '').includes('rate_limit')) return 'rate-limited';
  if (error.code === 'otp_expired' && nowMs - sentAtMs >= CODE_EXPIRY_MS) return 'expired';
  return 'wrong';
}

/** Exchange the emailed code for a session; the one network call of this step. */
export async function verifyEmailCode(
  client: CodeAuthClient,
  email: string,
  token: string,
  sentAtMs: number,
  nowMs: () => number = Date.now,
): Promise<VerifyCodeResult> {
  const { error } = await client.auth.verifyOtp({ email: email.trim(), token, type: 'email' });
  if (error) return { status: 'error', kind: codeErrorKind(error, sentAtMs, nowMs()) };
  return { status: 'signed-in' };
}

/** Only digits, at most CODE_LENGTH of them (a pasted "123 456" or "123-456" still fits). */
export function codeDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** The cooldown as m:ss, e.g. 28 -> "0:28". */
export function cooldownClock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const client = supabase as unknown as CodeAuthClient;

type StepError = { kind: CodeErrorKind } | { kind: 'send'; text: string };

function errorLine(error: StepError): string {
  if (error.kind === 'send') return error.text;
  if (error.kind === 'expired') return CHECK_EMAIL_COPY.expiredCode;
  if (error.kind === 'rate-limited') return CHECK_EMAIL_COPY.rateLimited;
  return CHECK_EMAIL_COPY.wrongCode;
}

/** "Resend in 0:28": the clock in mono tabular digits, like every time on screen. */
function ResendIn({ clock }: { clock: string }): ReactElement {
  return (
    <span>
      {CHECK_EMAIL_COPY.resendIn} <span className="font-mono tabular-nums">{clock}</span>
    </span>
  );
}

interface CodeStepProps {
  email: string;
  /** Sends a new code; resolves to the line to show on failure, or null once sent. */
  onResend: () => Promise<string | null>;
  /** Back to the email form, email kept. */
  onDifferentEmail: () => void;
  /** After verifyOtp signs in: the page routes on, as the link callback did. */
  onSignedIn: () => void;
}

/**
 * The enter-the-code step inside the same AuthShell card. Six boxes drawn over
 * ONE real input (autocomplete one-time-code), so iOS offers the code from Mail
 * above the keyboard and a paste fills every box. The sixth digit submits.
 */
export function CodeStep({
  email,
  onResend,
  onDifferentEmail,
  onSignedIn,
}: CodeStepProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const sentAt = useRef(Date.now());
  const inFlight = useRef(false);
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<StepError | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  async function submit(token: string): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setVerifying(true);
    const result = await verifyEmailCode(client, email, token, sentAt.current);
    inFlight.current = false;
    if (result.status === 'signed-in') {
      onSignedIn();
      return;
    }
    setVerifying(false);
    setCode('');
    setError({ kind: result.kind });
    inputRef.current?.focus();
  }

  function handleChange(raw: string): void {
    const digits = codeDigits(raw);
    setCode(digits);
    // A new try clears a wrong-code line; expired stays until a new code is sent.
    if (digits !== '' && error !== null && error.kind !== 'expired') setError(null);
    if (digits.length === CODE_LENGTH) void submit(digits);
  }

  async function handleResend(): Promise<void> {
    if (cooldown > 0 || resending) return;
    setResending(true);
    const failure = await onResend();
    setResending(false);
    if (failure !== null) {
      setError({ kind: 'send', text: failure });
      return;
    }
    sentAt.current = Date.now();
    setError(null);
    setCode('');
    setCooldown(RESEND_COOLDOWN_SECONDS);
    inputRef.current?.focus();
  }

  const active = focused && !verifying ? Math.min(code.length, CODE_LENGTH - 1) : -1;
  const invalid = error !== null && error.kind !== 'send';

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <div aria-hidden="true" className="grid grid-cols-6 gap-2">
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <div
              key={i}
              data-code-box=""
              className={cn(
                'flex h-14 items-center justify-center rounded-lg border bg-panel-2 font-mono text-2xl font-medium tabular-nums text-fg transition-colors duration-fast ease-enter',
                invalid ? 'border-bad' : i === active ? 'border-accent' : 'border-border',
              )}
            >
              {code[i] ?? ''}
            </div>
          ))}
        </div>
        <input
          ref={inputRef}
          id="auth-code"
          aria-label={CHECK_EMAIL_COPY.codeTitle}
          aria-invalid={invalid}
          aria-describedby={error !== null ? 'auth-code-error' : undefined}
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={CODE_LENGTH}
          // The keyboard opens with the step; the card swap follows the user's own tap.
          autoFocus
          readOnly={verifying}
          value={code}
          onChange={(event) => handleChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="absolute inset-0 h-full w-full cursor-text bg-transparent text-input text-transparent caret-transparent outline-none selection:bg-transparent"
        />
      </div>

      {error !== null ? (
        <ErrorNote className="flex flex-wrap items-center gap-x-1">
          <span id="auth-code-error">{errorLine(error)}</span>
          {error.kind === 'expired' ? (
            <Button variant="link" onClick={() => void handleResend()} disabled={resending}>
              {CHECK_EMAIL_COPY.resendCode}
            </Button>
          ) : null}
        </ErrorNote>
      ) : null}

      {error?.kind === 'expired' ? null : (
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => void handleResend()}
          disabled={cooldown > 0 || resending}
        >
          {cooldown > 0 ? (
            <ResendIn clock={cooldownClock(cooldown)} />
          ) : (
            CHECK_EMAIL_COPY.resendCode
          )}
        </Button>
      )}
      <Button type="button" onClick={onDifferentEmail} variant="link" className="w-full">
        {CHECK_EMAIL_COPY.differentEmail}
      </Button>
    </div>
  );
}
