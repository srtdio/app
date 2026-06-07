// Service-role Supabase client factory for flag writes.
//
// Writes to public.feature_flags and the audit_log_write RPC run with the
// service role (PR 23 will lock the table to operators via RLS; until then the
// privileged path is the only writer). The key and URL are configuration and
// MUST come from the environment, never hardcoded: in Workers from the request
// env bindings, in tests from the local-stack connection details. No project id
// is referenced here; the URL fully identifies the target project.
//
// Reads (evalFlag, listFlags) deliberately do NOT use this client: they accept a
// caller-supplied authenticated client so evaluation runs under the principal's
// RLS context, never with service-role privileges.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';

export interface FlagsServiceEnv {
  SUPABASE_URL?: string | undefined;
  SUPABASE_SECRET_KEY?: string | undefined;
}

/**
 * Build a service-role client from environment configuration. Throws if either
 * the URL or the secret key is absent so misconfiguration fails loudly rather
 * than silently writing nowhere.
 */
export function createFlagsServiceClient(env: FlagsServiceEnv): SupabaseClient<Database> {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SECRET_KEY;
  if (!url) {
    throw new Error('createFlagsServiceClient: SUPABASE_URL is required');
  }
  if (!serviceKey) {
    throw new Error('createFlagsServiceClient: SUPABASE_SECRET_KEY is required');
  }
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
