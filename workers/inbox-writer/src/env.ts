// Worker environment bindings and a structured JSON logger. Secrets are
// supplied as Worker secrets / env vars (never committed); the KV namespace
// inbox_writer_dedupe is bound as INBOX_DEDUPE in wrangler.toml.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import type { DedupeKv, ProcessDeps } from './process';
import { uuidv7 } from './uuid';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Project JWT secret, used to mint short-lived service_role+sub tokens. */
  SUPABASE_JWT_SECRET: string;
  /** KV namespace inbox_writer_dedupe. */
  INBOX_DEDUPE: DedupeKv;
}

/** Single-line JSON log to stdout; Logpush ships it to the R2 sink. */
function log(line: Record<string, unknown>): void {
  // The worker has no access to src/lib/logger.ts (frontend); it emits the same
  // single-line JSON contract directly. console is the only sink in a Worker
  // (the no-console rule is scoped to src/**, not workers/**).
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'inbox-writer', ...line }));
}

/** Build the service-role read/audit client (bare key; no acting member). */
export function readerClient(env: Env): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function buildDeps(env: Env): ProcessDeps {
  return {
    readerClient: readerClient(env),
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    jwtSecret: env.SUPABASE_JWT_SECRET,
    kv: env.INBOX_DEDUPE,
    newTraceId: uuidv7,
    log,
  };
}
