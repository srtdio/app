// Supabase Edge Function: POST /invite-send
//
// Self-contained: NO @srtdio/* imports. The Deno edge bundler rejects the
// @srtdio/* packages because their internal relative imports omit the .ts
// extension, so the canonical logic from packages/workspace (inviteMember) and
// packages/auth (the Resend sender) is inlined verbatim here. The only external
// imports are @supabase/supabase-js, zod and mailchecker via the function
// deno.json map. mailchecker is bound here, not imported by handler.ts, so the
// handler still unit-tests under Node where the package is not installed.
//
// Device-fingerprint enforcement is intentionally OMITTED on this endpoint
// (deferred to later hardening). verify_jwt stays ON at the gateway.
//
// The request handling lives in handler.ts (unit-tested under Node); this
// entry only binds it to the runtime env and the supabase-js client factory.

import { createClient } from '@supabase/supabase-js';
import MailChecker from 'mailchecker';
import { handleInviteSend } from './handler.ts';

// The email is sent before the response (no EdgeRuntime.waitUntil), so the
// answer's emailed / error_detail tell the inviter whether it went out.
Deno.serve((req: Request) =>
  handleInviteSend(req, {
    env: (name) => Deno.env.get(name),
    createClient,
    // mailchecker's isValid is false for a throwaway domain (or any parent of
    // one). zod has already accepted the syntax, so false here means throwaway.
    isDisposableEmail: (email: string): boolean => !MailChecker.isValid(email),
  }),
);
