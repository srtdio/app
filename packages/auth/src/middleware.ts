// The fingerprint gate every authed edge function and worker mounts. Unlike
// registerSession (service role), this runs through the caller's own JWT so RLS
// scopes every read and write to auth.uid().

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { UnauthorizedError } from './errors.ts';
import { FINGERPRINT_HEADER, isValidFingerprint } from './fingerprint.ts';

/**
 * Per-request context handed to every middleware. `userId` is auth.uid()
 * resolved upstream from the verified JWT; `client` is the user-scoped (RLS)
 * Supabase client, never the service role.
 */
export interface AuthContext {
  request: Request;
  userId: string;
  client: SupabaseClient<Database>;
  traceId: string;
}

/**
 * A middleware either calls `next()` to continue the chain or throws an
 * HttpError to short-circuit the request with a status.
 */
export type Middleware = (ctx: AuthContext, next: () => Promise<Response>) => Promise<Response>;

/**
 * Gate a request on an active session_devices row for the caller's device.
 * Reads X-Device-Fingerprint, then queries session_devices THROUGH the user JWT
 * (so RLS confines the lookup to auth.uid()) for an un-revoked row matching that
 * fingerprint. A hit refreshes last_seen_at and continues; a miss - an absent or
 * malformed header, or no matching active row - is a 401.
 */
export function fingerprintMiddleware(): Middleware {
  return async (ctx, next) => {
    const fingerprint = ctx.request.headers.get(FINGERPRINT_HEADER);
    if (!isValidFingerprint(fingerprint)) {
      throw new UnauthorizedError('Missing or malformed device fingerprint.');
    }

    const found = await ctx.client
      .from('session_devices')
      .select('id')
      .eq('user_id', ctx.userId)
      .eq('fingerprint_hash', fingerprint)
      .is('revoked_at', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (found.error || !found.data) {
      throw new UnauthorizedError('No active session for this device.');
    }

    const touch = await ctx.client
      .from('session_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', found.data.id);
    if (touch.error) {
      throw new UnauthorizedError('Session could not be refreshed.');
    }

    return next();
  };
}
