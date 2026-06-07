// Magic-link signup and the verification handler that completes it.
//
// Signup never asks for a password: the user supplies an email and a
// display_name (timezone is auto-detected client-side and passed in), GoTrue
// emails a magic link, and the existing users_create_profile_on_signup()
// trigger mirrors the new auth.users row into public.users. The trigger reads
// the display name from raw_user_meta_data.full_name, so we send it there.
// Verification consumes the emailed token and returns a live session.

import type { EmailOtpType, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '@/server/logger';
import { mapAuthError } from './errors';
import { toAuthSession } from './session';
import { fail, ok, type AuthSession, type Result } from './types';

export const DISPLAY_NAME_MIN = 1;
export const DISPLAY_NAME_MAX = 80;

const emailSchema = z.string().email();

export interface SignupInput {
  email: string;
  displayName: string;
  /** IANA timezone auto-detected by the client (e.g. "Asia/Kolkata"). */
  timezone: string;
  /** Where the magic link returns the user; defaults to the app's verify route. */
  emailRedirectTo?: string;
}

/**
 * Begin magic-link signup. Validates the display name (1..80 chars) before
 * touching the provider so an invalid name is a fast domain error and never
 * reaches the database CHECK. On success GoTrue creates the (unconfirmed)
 * auth.users row, firing the profile trigger, and sends the magic link.
 */
export async function signupWithMagicLink(
  client: SupabaseClient,
  input: SignupInput,
  traceId: string,
): Promise<Result<{ email: string }>> {
  logger.setTraceId(traceId);

  const displayName = input.displayName.trim();
  if (displayName.length < DISPLAY_NAME_MIN || displayName.length > DISPLAY_NAME_MAX) {
    return fail(
      'invalid_display_name',
      `display_name must be ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters.`,
    );
  }
  if (!emailSchema.safeParse(input.email).success) {
    return fail('invalid_email', 'A valid email address is required.');
  }
  if (input.timezone.trim().length === 0) {
    return fail('invalid_email', 'A timezone is required.');
  }

  const { error } = await client.auth.signInWithOtp({
    email: input.email,
    options: {
      shouldCreateUser: true,
      // full_name is what the profile trigger reads; the rest is carried for
      // later workspace creation.
      data: {
        full_name: displayName,
        display_name: displayName,
        timezone: input.timezone.trim(),
      },
      ...(input.emailRedirectTo ? { emailRedirectTo: input.emailRedirectTo } : {}),
    },
  });
  if (error) {
    const mapped = mapAuthError(error);
    logger.warn('auth.signup failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }
  return ok({ email: input.email });
}

export interface VerifyMagicLinkInput {
  /** The hashed_token delivered in the magic link. */
  tokenHash: string;
  /** Verification type GoTrue assigned to the link (magiclink for signup). */
  type?: EmailOtpType;
}

/**
 * Complete signup (or magic-link login) by consuming the emailed token. An
 * expired or already-used token maps to expired_token rather than throwing.
 */
export async function verifyMagicLink(
  client: SupabaseClient,
  input: VerifyMagicLinkInput,
  traceId: string,
): Promise<Result<AuthSession>> {
  logger.setTraceId(traceId);
  if (!input.tokenHash) {
    return fail('invalid_token', 'A token is required to verify the magic link.');
  }

  const { data, error } = await client.auth.verifyOtp({
    token_hash: input.tokenHash,
    type: input.type ?? 'magiclink',
  });
  if (error || !data.session) {
    const mapped = error
      ? mapAuthError(error)
      : { code: 'expired_token' as const, message: 'The magic link is invalid or has expired.' };
    logger.warn('auth.verify failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }
  return ok(toAuthSession(data.session));
}
