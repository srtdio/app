// Email + password login.

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/server/logger';
import { mapAuthError } from './errors';
import { toAuthSession } from './session';
import { fail, ok, type AuthSession, type Result } from './types';

export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Sign in with email + password. A wrong password or unknown email is the
 * expected invalid_credentials value; GoTrue intentionally does not say which.
 */
export async function loginWithPassword(
  client: SupabaseClient,
  input: LoginInput,
  traceId: string,
): Promise<Result<AuthSession>> {
  logger.setTraceId(traceId);
  if (!input.email || !input.password) {
    return fail('invalid_credentials', 'Email and password are required.');
  }

  const { data, error } = await client.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });
  if (error || !data.session) {
    const mapped = error
      ? mapAuthError(error)
      : { code: 'invalid_credentials' as const, message: 'No session returned.' };
    logger.warn('auth.login failed', { code: mapped.code });
    return { ok: false, error: mapped };
  }
  return ok(toAuthSession(data.session));
}
