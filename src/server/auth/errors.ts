// Translate a Supabase AuthError into a stable DomainError.
//
// GoTrue surfaces failures as an AuthError carrying a machine `code`, an HTTP
// `status`, and a human `message`. We map to our closed DomainErrorCode set so
// callers branch on intent, not on a provider string that may change. The
// ordering below matters: "expired" is checked before "invalid" because an
// expired JWT's message contains both words.

import { AuthError } from '@supabase/supabase-js';
import type { DomainError, DomainErrorCode } from './types';

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** Map a Supabase auth error (or any thrown value) to a DomainError. */
export function mapAuthError(error: unknown): DomainError {
  if (!(error instanceof AuthError)) {
    const message = error instanceof Error ? error.message : 'Unexpected authentication error';
    return { code: 'unknown', message };
  }

  const code = error.code ?? '';
  const status = error.status ?? 0;
  const msg = error.message.toLowerCase();

  let domain: DomainErrorCode;
  if (status === 429 || code.includes('rate') || msg.includes('rate limit')) {
    domain = 'rate_limited';
  } else if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) {
    domain = 'invalid_credentials';
  } else if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) {
    domain = 'email_not_confirmed';
  } else if (
    code === 'otp_expired' ||
    msg.includes('token is expired') ||
    msg.includes('jwt expired') ||
    includesAny(msg, ['expired', 'has expired'])
  ) {
    domain = 'expired_token';
  } else if (code.includes('refresh_token') || msg.includes('refresh token')) {
    domain = 'session_revoked';
  } else if (includesAny(msg, ['invalid', 'signature', 'malformed'])) {
    domain = 'invalid_token';
  } else if (status === 401 || status === 403) {
    domain = 'unauthenticated';
  } else {
    domain = 'unknown';
  }

  return { code: domain, message: error.message };
}
