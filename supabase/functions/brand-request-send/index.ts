// Supabase Edge Function: POST /brand-request-send
//
// An approver who signed up alone names the person who makes their posts.
// This records the request through brand_agency_request (as the caller, so
// auth.uid() is the actor) and emails that person a sign-up link.
//
// Self-contained: NO @srtdio/* imports, for the same reason as invite-send
// (the Deno edge bundler rejects their extensionless relative imports).
//
// The request handling lives in handler.ts (unit-tested under Node); this
// entry only binds it to the runtime env and the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import { handleBrandRequestSend } from './handler.ts';

Deno.serve((req: Request) =>
  handleBrandRequestSend(req, { env: (name) => Deno.env.get(name), createClient }),
);
