// Register-then-validate roundtrip against a local, ephemeral Supabase stack.
// registerSession runs as the service role (the privileged path the edge
// function uses); the fingerprint gate then runs through the seeded user's own
// JWT, proving RLS lets a device see and refresh its own active session and
// nothing else. Gated by AUTH_SUITE like the rest of tests/auth.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  clientFor,
  createAdminClient,
  randomSha256,
  seedUser,
  type SeededUser,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  fingerprintMiddleware,
  registerSession,
  STALE_SESSION_MS,
  UnauthorizedError,
  type AuthContext,
} from '../../packages/auth/src/index';
import { loadAuthTestEnv, type AuthTestEnv } from './env';

const AUTH_SUITE = process.env.AUTH_SUITE === '1';

const TRACE_ID = '01931a0b-0000-7000-8000-000000000007';

function contextFor(user: SeededUser, fingerprint: string): AuthContext {
  const headers = new Headers({ 'X-Device-Fingerprint': fingerprint });
  return {
    request: new Request('https://api.test/resource', { method: 'POST', headers }),
    userId: user.id,
    client: clientFor(user.id),
    traceId: TRACE_ID,
  };
}

const proceed = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));

async function activeCount(
  admin: SupabaseClient<Database>,
  userId: string,
  fingerprint: string,
): Promise<number> {
  const res = await admin
    .from('session_devices')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('fingerprint_hash', fingerprint)
    .is('revoked_at', null);
  if (res.error) throw new Error(`active count failed: ${res.error.message}`);
  return res.count ?? 0;
}

describe.runIf(AUTH_SUITE)('session-register + fingerprint gate roundtrip', () => {
  let env: AuthTestEnv;
  let admin: SupabaseClient<Database>;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    env = loadAuthTestEnv();
    admin = createAdminClient(env);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await admin.from('session_devices').delete().eq('user_id', id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  it('registers a device, then lets that device pass the fingerprint gate', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);
    const fingerprint = randomSha256();

    const first = await registerSession(admin, {
      userId: user.id,
      fingerprintHash: fingerprint,
      userAgent: 'vitest/roundtrip',
      ipSubnet: '203.0.113.0/24',
    });
    expect(first.action).toBe('inserted');

    const before = await admin
      .from('session_devices')
      .select('id, last_seen_at')
      .eq('id', first.id)
      .single();
    expect(before.error).toBeNull();

    const res = await fingerprintMiddleware()(contextFor(user, fingerprint), proceed);
    expect(res.status).toBe(204);

    const after = await admin
      .from('session_devices')
      .select('last_seen_at')
      .eq('id', first.id)
      .single();
    expect(after.error).toBeNull();
    expect(Date.parse(after.data?.last_seen_at ?? '')).toBeGreaterThanOrEqual(
      Date.parse(before.data?.last_seen_at ?? ''),
    );
  });

  it('rejects the gate for a device that never registered', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    await registerSession(admin, {
      userId: user.id,
      fingerprintHash: randomSha256(),
      userAgent: null,
      ipSubnet: null,
    });

    const strangerFingerprint = randomSha256();
    await expect(
      fingerprintMiddleware()(contextFor(user, strangerFingerprint), proceed),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('is idempotent: re-registering the same device refreshes one row', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);
    const fingerprint = randomSha256();

    const first = await registerSession(admin, {
      userId: user.id,
      fingerprintHash: fingerprint,
      userAgent: 'vitest',
      ipSubnet: null,
    });
    const second = await registerSession(admin, {
      userId: user.id,
      fingerprintHash: fingerprint,
      userAgent: 'vitest',
      ipSubnet: null,
    });

    expect(first.action).toBe('inserted');
    expect(second).toEqual({ action: 'refreshed', id: first.id });
    expect(await activeCount(admin, user.id, fingerprint)).toBe(1);
  });

  it('revokes a stale active row (older than 24h) and opens a fresh one', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);
    const fingerprint = randomSha256();

    const stale = await admin
      .from('session_devices')
      .insert({
        user_id: user.id,
        fingerprint_hash: fingerprint,
        user_agent: 'old',
        last_seen_at: new Date(Date.now() - STALE_SESSION_MS - 60_000).toISOString(),
      })
      .select('id')
      .single();
    expect(stale.error).toBeNull();

    const result = await registerSession(admin, {
      userId: user.id,
      fingerprintHash: fingerprint,
      userAgent: 'new',
      ipSubnet: null,
    });
    expect(result.action).toBe('inserted');
    expect(result.id).not.toBe(stale.data?.id);

    const staleRow = await admin
      .from('session_devices')
      .select('revoked_at')
      .eq('id', stale.data?.id ?? '')
      .single();
    expect(staleRow.error).toBeNull();
    expect(staleRow.data?.revoked_at).not.toBeNull();

    expect(await activeCount(admin, user.id, fingerprint)).toBe(1);
  });
});
