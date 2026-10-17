// Supabase Edge Function: POST /demo-request-send
//
// The public Book a demo form (srtd.io/demo) posts the visitor's name, email,
// mobile and chosen IST day and slot; this mails the request to the team inbox.
// No bearer: verify_jwt is off for this function in supabase/config.toml.
//
// Self-contained: NO @srtdio/* imports, for the same reason as invite-send
// (the Deno edge bundler rejects their extensionless relative imports).
//
// The request handling lives in handler.ts (unit-tested under Node); this
// entry only binds it to the runtime env and the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import { handleDemoRequestSend } from './handler.ts';

Deno.serve((req: Request) =>
  handleDemoRequestSend(req, { env: (name) => Deno.env.get(name), createClient }),
);
