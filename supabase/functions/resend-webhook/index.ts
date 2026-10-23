// Supabase Edge Function: POST /resend-webhook
//
// Resend delivery-status receiver: email.delivered / email.bounced /
// email.complained update the matching public.delivery_attempts row. verify_jwt
// is off (Resend sends no Supabase JWT); the Svix signature is the boundary.
//
// Self-contained: NO @srtdio/* imports (the Deno edge bundler rejects their
// extensionless relative imports). The request handling lives in handler.ts
// (unit-tested under Node); this entry only binds it to the runtime env and
// the supabase-js client factory, plus the svix verifier (npm, MIT).

import { createClient } from '@supabase/supabase-js';
import { Webhook } from 'svix';
import { handleResendWebhook } from './handler.ts';

Deno.serve((req: Request) =>
  handleResendWebhook(req, {
    env: (name) => Deno.env.get(name),
    createClient,
    // svix verifies the signature and the timestamp window; it throws on failure.
    verifySignature: (secret, body, headers) => {
      new Webhook(secret).verify(body, headers);
    },
  }),
);
