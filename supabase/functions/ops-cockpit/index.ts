// Supabase Edge Function: GET /ops-cockpit
//
// The platform operator's Cockpit: one health dot (mode=status) and the live
// panel's tabs (mode=full). Everyone who is not the operator gets 404.
// Deployed with --no-verify-jwt (functions-deploy.yml): the handler verifies
// the caller's token itself, so a missing or bad token is a 404 like any
// other non-operator, never the gateway's 401.
//
// Self-contained: NO @srtdio/* imports (the Deno edge bundler rejects their
// extensionless relative imports). The request handling lives in handler.ts
// (unit-tested under Node); this entry only binds it to the runtime env, the
// supabase-js client factory and one small read-only postgres pool for the
// Email and Chat aggregates (SUPABASE_DB_URL, set by the platform).

import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { handleOpsCockpit } from './handler.ts';
import type { SqlRunner } from './sources.ts';

const dbUrl = Deno.env.get('SUPABASE_DB_URL');
// One pool per isolate; prepare: false for the transaction pooler.
const db = dbUrl ? postgres(dbUrl, { prepare: false, max: 3, idle_timeout: 20 }) : null;
const sql: SqlRunner | null =
  db === null ? null : (text) => db.unsafe(text) as unknown as Promise<Record<string, unknown>[]>;

Deno.serve((req: Request) =>
  handleOpsCockpit(req, {
    env: (name) => Deno.env.get(name),
    createClient,
    // globalThis.fetch (not the bare global) satisfies the ESLint fetch guard.
    fetch: (input, init) => globalThis.fetch(input, init),
    sql,
  }),
);
