// Supabase Edge Function: POST /invite-send
//
// Self-contained: NO @srtdio/* imports. The Deno edge bundler rejects the
// @srtdio/* packages because their internal relative imports omit the .ts
// extension, so the canonical logic from packages/workspace (inviteMember) and
// packages/auth (the Resend sender) is inlined verbatim here. The only external
// imports are @supabase/supabase-js and zod via the function deno.json map.
//
// Device-fingerprint enforcement is intentionally OMITTED on this endpoint
// (deferred to later hardening). verify_jwt stays ON at the gateway.
//
// The request handling lives in handler.ts (unit-tested under Node); this
// entry only binds it to the runtime env and the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import { handleInviteSend } from './handler.ts';

// The email is sent before the response (no EdgeRuntime.waitUntil), so the
// answer's emailed / error_detail tell the inviter whether it went out.
Deno.serve((req: Request) =>
  handleInviteSend(req, {
    env: (name) => Deno.env.get(name),
    createClient,
  }),
);
