// Password reset: request a recovery link, then confirm a new password.
//
// The request step never reveals whether an email exists (GoTrue returns ok
// regardless) to avoid user enumeration. Confirm consumes the recovery token to
// establish a short-lived session and sets the new password on that session.

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '@/server/logger';
import { mapAuthError } from './errors';
import { toAuthSession } from './session';
import { fail, ok, type AuthSession, type Result } from './types';

export const PASSWORD_MIN = 8;

const emailSchema = z.string().email();

export interface ResetRequestInput {
  email: string;
  /** Where the recovery link returns the user. */
  redirectTo?: string;
}

/** Send a password-reset email. Resolves ok even for unknown addresses. */
export async function requestPasswordReset(
  client: SupabaseClient,
  input: ResetRequestInput,
  traceId: string,
): Promise<Result<{ email: string }>> {
  logger.setTraceId(traceId);
  if (!emailSchema.safeParse(input.email).success) {
    return fail('invalid_email', 'A valid email address is required.');
  }

  const { error } = await client.auth.resetPasswordForEmail(
    input.email,
    input.redirectTo ? { redirectTo: input.redirectTo } : undefined,
  );
  if (error) {
    const mapped = mapAuthError(error);
    logger.warn('auth.reset_request failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }
  return ok({ email: input.email });
}

export interface ResetConfirmInput {
  /** The hashed_token delivered in the recovery link. */
  tokenHash: string;
  newPassword: string;
}

/**
 * Confirm a reset: consume the recovery token, then set the new password on the
 * resulting session. An expired or used token maps to expired_token; a password
 * the provider rejects (too short / weak) maps to invalid_password.
 */
export async function confirmPasswordReset(
  client: SupabaseClient,
  input: ResetConfirmInput,
  traceId: string,
): Promise<Result<AuthSession>> {
  logger.setTraceId(traceId);
  if (!input.tokenHash) {
    return fail('invalid_token', 'A recovery token is required.');
  }
  if (input.newPassword.length < PASSWORD_MIN) {
    return fail('invalid_password', `Password must be at least ${PASSWORD_MIN} characters.`);
  }

  const verified = await client.auth.verifyOtp({ token_hash: input.tokenHash, type: 'recovery' });
  if (verified.error || !verified.data.session) {
    const mapped = verified.error
      ? mapAuthError(verified.error)
      : { code: 'expired_token' as const, message: 'The recovery link is invalid or has expired.' };
    logger.warn('auth.reset_confirm verify failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }

  const updated = await client.auth.updateUser({ password: input.newPassword });
  if (updated.error) {
    const mapped = mapAuthError(updated.error);
    // GoTrue reports weak/short passwords as a validation error, not a token one.
    const code = mapped.code === 'unknown' ? ('invalid_password' as const) : mapped.code;
    logger.warn('auth.reset_confirm update failed', { code });
    return { ok: false, error: { code, message: mapped.message } };
  }
  return ok(toAuthSession(verified.data.session));
}
