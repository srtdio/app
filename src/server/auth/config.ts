// Environment and client construction for the auth server.
//
// Every secret comes from the environment, never a committed constant: the
// Supabase project URL, the anon (publishable) key used for end-user flows, and
// the secret (service-role) key used only for privileged admin calls. The two
// clients are deliberately separate so an end-user flow can never reach a
// service-role capability by accident.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/** Access token lifetime contract. The Supabase project is configured to mint
 * 15-minute access tokens; long-lived sessions live in session_devices. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const authEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SECRET_KEY: z.string().min(20),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

/**
 * Validate and return the auth environment. Throws (not a Result) when config
 * is missing or malformed: a misconfigured server is a deploy-time fault, not
 * an expected per-request failure.
 */
export function loadAuthEnv(source: Record<string, string | undefined> = process.env): AuthEnv {
  const parsed = authEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid auth environment configuration:\n${issues}`);
  }
  return parsed.data;
}

const noPersist = { auth: { autoRefreshToken: false, persistSession: false } } as const;

/**
 * Anon-key client for end-user flows (signup, login, verify, refresh, reset).
 * Sessions are never persisted: each request is stateless and any session it
 * needs is supplied explicitly by the caller.
 */
export function createAnonAuthClient(env: AuthEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, noPersist);
}

/**
 * Service-role client. Bypasses RLS and unlocks the GoTrue admin API; only the
 * server may hold it. Used for privileged operations, never handed to a browser.
 */
export function createServiceAuthClient(env: AuthEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, noPersist);
}
