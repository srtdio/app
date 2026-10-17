// Supabase Edge Function: POST /book-call-send
//
// A signed-in member picks a call slot in the app. This emails the team inbox
// (BOOK_CALL_TO_ADDRESS) with who asked, for which workspace, and when.
//
// Self-contained: NO @srtdio/* imports, for the same reason as invite-send
// (the Deno edge bundler rejects their extensionless relative imports).
//
// The request handling lives in handler.ts (unit-tested under Node); this
// entry only binds it to the runtime env and the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import { handleBookCallSend } from './handler.ts';

Deno.serve((req: Request) =>
  handleBookCallSend(req, { env: (name) => Deno.env.get(name), createClient }),
);
