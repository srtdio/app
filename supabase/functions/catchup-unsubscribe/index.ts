// Supabase Edge Function: /catchup-unsubscribe
//
// Unsubscribe endpoint for the catch-up email: the RFC 8058 one-click POST
// target in the List-Unsubscribe header, and the API behind the app's
// /unsubscribe page. verify_jwt is off; the signed token is the boundary.
//
// Self-contained: NO @srtdio/* imports (the Deno edge bundler rejects their
// extensionless relative imports). The request handling lives in handler.ts
// (unit-tested under Node); this entry only binds it to the runtime env and
// the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import { handleCatchupUnsubscribe } from './handler.ts';

Deno.serve((req: Request) =>
  handleCatchupUnsubscribe(req, { env: (name) => Deno.env.get(name), createClient }),
);
