// Idempotent session_devices registration. Runs ONLY with a service-role client
// (the table grants no INSERT to the authenticated role), so the caller's
// identity must already be resolved server-side from the JWT and passed as
// userId - never trusted from the request body.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { BadRequestError } from './errors.ts';
import { isValidFingerprint } from './fingerprint.ts';

/**
 * Active sessions for the same device that have not been seen in this long are
 * revoked when the device re-registers.
 */
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

export interface RegisterSessionInput {
  /** auth.uid() resolved server-side from the verified JWT. Never request-supplied. */
  userId: string;
  /** The X-Device-Fingerprint value; validated here before any write. */
  fingerprintHash: string;
  /** Request user agent, or null when absent. */
  userAgent: string | null;
  /** Coarsened /24 or /48 CIDR (see ipSubnet), or null. */
  ipSubnet: string | null;
  /** Clock injection point so the 24h cutoff is deterministic in tests. */
  now?: Date;
}

export type RegisterSessionResult =
  | { action: 'inserted'; id: string }
  | { action: 'refreshed'; id: string };

type Client = SupabaseClient<Database>;

/**
 * Record the calling device's active session, idempotently. The fingerprint is
 * validated first; an invalid one is a 400 and never touches the table. Then,
 * for the (user_id, fingerprint_hash) pair:
 *   1. prior active rows last seen more than 24h ago are revoked, then
 *   2. a surviving active row has its last_seen_at (and agent/subnet) refreshed,
 *      or a fresh row is inserted when none survives.
 * Re-calling within the window refreshes the same row, so retries are safe.
 */
export async function registerSession(
  client: Client,
  input: RegisterSessionInput,
): Promise<RegisterSessionResult> {
  if (!isValidFingerprint(input.fingerprintHash)) {
    throw new BadRequestError('X-Device-Fingerprint must be 64 lowercase hex characters.');
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - STALE_SESSION_MS).toISOString();

  // 1. Revoke this device's stale active rows.
  const revoke = await client
    .from('session_devices')
    .update({ revoked_at: nowIso })
    .eq('user_id', input.userId)
    .eq('fingerprint_hash', input.fingerprintHash)
    .is('revoked_at', null)
    .lt('last_seen_at', cutoffIso);
  if (revoke.error) {
    throw new Error(`session_devices revoke failed: ${revoke.error.message}`);
  }

  // 2. Refresh a surviving active row, or insert a fresh one.
  const existing = await client
    .from('session_devices')
    .select('id')
    .eq('user_id', input.userId)
    .eq('fingerprint_hash', input.fingerprintHash)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`session_devices lookup failed: ${existing.error.message}`);
  }

  if (existing.data) {
    const refreshed = await client
      .from('session_devices')
      .update({
        last_seen_at: nowIso,
        user_agent: input.userAgent,
        ip_subnet: input.ipSubnet,
      })
      .eq('id', existing.data.id);
    if (refreshed.error) {
      throw new Error(`session_devices refresh failed: ${refreshed.error.message}`);
    }
    return { action: 'refreshed', id: existing.data.id };
  }

  const inserted = await client
    .from('session_devices')
    .insert({
      user_id: input.userId,
      fingerprint_hash: input.fingerprintHash,
      user_agent: input.userAgent,
      ip_subnet: input.ipSubnet,
      last_seen_at: nowIso,
    })
    .select('id')
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(`session_devices insert failed: ${inserted.error?.message ?? 'no row'}`);
  }
  return { action: 'inserted', id: inserted.data.id };
}
