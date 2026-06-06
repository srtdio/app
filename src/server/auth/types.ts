// Result and domain-error shapes shared by every auth endpoint.
//
// Auth handlers NEVER throw for an expected failure (bad credentials, an
// expired or already-used token, a rate limit). Those are values: a handler
// returns { ok: false, error } and the caller branches on `ok`. Only genuinely
// unexpected faults (the network is down, the env is misconfigured) are allowed
// to throw out of a handler.

export type DomainErrorCode =
  | 'invalid_display_name'
  | 'invalid_email'
  | 'invalid_password'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'expired_token'
  | 'invalid_token'
  | 'session_revoked'
  | 'rate_limited'
  | 'unauthenticated'
  | 'unknown';

export interface DomainError {
  code: DomainErrorCode;
  message: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: DomainError };

/** Normalized session returned to callers; never leaks the raw provider shape. */
export interface AuthSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds at which the access token expires. */
  expiresAt: number;
  /** Lifetime of the access token in seconds (15 min by project config). */
  expiresIn: number;
  tokenType: string;
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(code: DomainErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}
