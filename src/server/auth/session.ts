// Session lifecycle: normalize a provider session, refresh an access token,
// revoke a refresh token on sign-out, and verify a bearer access token.

import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/server/logger';
import { mapAuthError } from './errors';
import { fail, ok, type AuthSession, type Result } from './types';

/** Collapse a GoTrue session into the normalized {@link AuthSession}. */
export function toAuthSession(session: Session): AuthSession {
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 0);
  return {
    userId: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt,
    expiresIn: session.expires_in,
    tokenType: session.token_type,
  };
}

export interface RefreshInput {
  refreshToken: string;
}

/**
 * Exchange a refresh token for a fresh access token. A revoked or unknown
 * refresh token (e.g. after sign-out) is an expected failure, not a throw.
 */
export async function refreshSession(
  client: SupabaseClient,
  input: RefreshInput,
  traceId: string,
): Promise<Result<AuthSession>> {
  logger.setTraceId(traceId);
  if (!input.refreshToken) {
    return fail('invalid_token', 'A refresh token is required.');
  }

  const { data, error } = await client.auth.refreshSession({ refresh_token: input.refreshToken });
  if (error || !data.session) {
    const mapped = error
      ? mapAuthError(error)
      : { code: 'session_revoked' as const, message: 'No session returned.' };
    logger.warn('auth.refresh failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }
  return ok(toAuthSession(data.session));
}

export interface SignOutInput {
  accessToken: string;
  refreshToken: string;
}

/**
 * Revoke the session's refresh token server-side. We hydrate an ephemeral
 * session from the supplied tokens, then call GoTrue logout with global scope so
 * the refresh token can no longer mint access tokens. Idempotent: signing out an
 * already-dead session still resolves ok.
 */
export async function signOut(
  client: SupabaseClient,
  input: SignOutInput,
  traceId: string,
): Promise<Result<{ revoked: true }>> {
  logger.setTraceId(traceId);
  if (!input.accessToken || !input.refreshToken) {
    return fail('invalid_token', 'Both access and refresh tokens are required to sign out.');
  }

  const setRes = await client.auth.setSession({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
  });
  if (setRes.error) {
    const mapped = mapAuthError(setRes.error);
    // An already-expired/revoked session is effectively signed out already.
    if (mapped.code === 'expired_token' || mapped.code === 'session_revoked') {
      return ok({ revoked: true });
    }
    logger.warn('auth.signout setSession failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }

  const { error } = await client.auth.signOut({ scope: 'global' });
  if (error) {
    const mapped = mapAuthError(error);
    logger.warn('auth.signout failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }
  return ok({ revoked: true });
}

/**
 * Verify a bearer access token against GoTrue and return the user id. An
 * expired or tampered token is an expected failure.
 */
export async function verifyAccessToken(
  client: SupabaseClient,
  accessToken: string,
  traceId: string,
): Promise<Result<{ userId: string }>> {
  logger.setTraceId(traceId);
  if (!accessToken) {
    return fail('invalid_token', 'An access token is required.');
  }

  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    const mapped = error
      ? mapAuthError(error)
      : { code: 'invalid_token' as const, message: 'No user for token.' };
    return { ok: false, error: mapped };
  }
  return ok({ userId: data.user.id });
}
