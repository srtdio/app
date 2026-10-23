// Supabase Edge Function: POST /resend-webhook
//
// Resend delivery-status receiver: email.delivered / email.bounced /
// email.complained update the matching public.delivery_attempts row. verify_jwt
// is off (Resend sends no Supabase JWT); the Svix signature is the boundary.
//
// Self-contained: NO @srtdio/* imports (the Deno edge bundler rejects their
// extensionless relative imports). The request handling lives in handler.ts
// (unit-tested under Node); this entry only binds it to the runtime env and
// the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import { handleResendWebhook } from './handler.ts';

Deno.serve((req: Request) =>
  handleResendWebhook(req, { env: (name) => Deno.env.get(name), createClient }),
);
