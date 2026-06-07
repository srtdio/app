// Acting-member authentication for service-side proc calls.
//
// inbox_entry_create gates on is_active_workspace_member(auth.uid()). A bare
// service-role key has no `sub`, so auth.uid() is null and the gate rejects it.
// We therefore mint a short-lived service_role JWT whose `sub` is an active
// member of the target workspace: the role keeps EXECUTE on the proc (which is
// not granted to authenticated) while auth.uid() resolves to a real member.
//
// This module is intentionally NOT re-exported from the package index: it is an
// implementation detail shared by the worker and the integration tests, not a
// part of the public @srtdio/inbox surface (writeInboxEntry / computeRecipients
// / extractMentions).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value: object): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Mint an HS256 service_role JWT for `sub`, valid for `ttlSeconds`. Signed with
 * the project's JWT secret via Web Crypto (works in Workers and Node 22).
 */
export async function mintServiceRoleToken(
  jwtSecret: string,
  sub: string,
  ttlSeconds = 300,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeSegment({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeSegment({
    role: 'service_role',
    sub,
    iss: 'supabase',
    iat: now,
    exp: now + ttlSeconds,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export interface ActingClientOptions {
  url: string;
  serviceKey: string;
  jwtSecret: string;
  /** User id to act as; must be an active member of every targeted workspace. */
  actingUserId: string;
  tokenTtlSeconds?: number;
}

/**
 * A Supabase client that authenticates as `actingUserId` with the service_role
 * role: service key as the apikey, a minted service_role+sub JWT as the bearer.
 */
export async function createActingClient(
  opts: ActingClientOptions,
): Promise<SupabaseClient<Database>> {
  const token = await mintServiceRoleToken(opts.jwtSecret, opts.actingUserId, opts.tokenTtlSeconds);
  return createClient<Database>(opts.url, opts.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
