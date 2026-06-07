// RLS isolation for session_devices: a user must see and touch only its own
// device rows. Rows are seeded through registerSession (service role); isolation
// is then asserted through each user's own JWT, with the owner's positive read
// proving a cross-user 0 is a real deny rather than a swallowed query error.
// Gated by AUTH_SUITE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  clientFor,
  createAdminClient,
  ownReadCount,
  randomSha256,
  seedUser,
  updateRowCount,
  visibleRowCount,
  type GenericClient,
  type SeededUser,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  fingerprintMiddleware,
  registerSession,
  UnauthorizedError,
  type AuthContext,
} from '../../packages/auth/src/index';
import { loadAuthTestEnv, type AuthTestEnv } from './env';

const AUTH_SUITE = process.env.AUTH_SUITE === '1';

function contextFor(user: SeededUser, fingerprint: string): AuthContext {
  const headers = new Headers({ 'X-Device-Fingerprint': fingerprint });
  return {
    request: new Request('https://api.test/resource', { method: 'POST', headers }),
    userId: user.id,
    client: clientFor(user.id),
    traceId: '01931a0b-0000-7000-8000-0000000000aa',
  };
}

const proceed = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));

describe.runIf(AUTH_SUITE)('session_devices RLS isolation', () => {
  let env: AuthTestEnv;
  let admin: SupabaseClient<Database>;
  let userA: SeededUser;
  let userB: SeededUser;
  let fingerprintA: string;
  let fingerprintB: string;

  beforeAll(async () => {
    env = loadAuthTestEnv();
    admin = createAdminClient(env);
    userA = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    fingerprintA = randomSha256();
    fingerprintB = randomSha256();

    await registerSession(admin, {
      userId: userA.id,
      fingerprintHash: fingerprintA,
      userAgent: 'device-a',
      ipSubnet: '203.0.113.0/24',
    });
    await registerSession(admin, {
      userId: userB.id,
      fingerprintHash: fingerprintB,
      userAgent: 'device-b',
      ipSubnet: '198.51.100.0/24',
    });
  });

  afterAll(async () => {
    for (const id of [userA?.id, userB?.id]) {
      if (!id) continue;
      await admin.from('session_devices').delete().eq('user_id', id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  it('hides user A device rows from user B', async () => {
    const attacker = asGeneric(clientFor(userB.id));
    const visible = await visibleRowCount(attacker, 'session_devices', [['user_id', userA.id]]);
    expect(visible).toBe(0);
  });

  it('lets user A read its own device rows (positive control)', async () => {
    const owner: GenericClient = asGeneric(clientFor(userA.id));
    const own = await ownReadCount(owner, 'session_devices', [['user_id', userA.id]]);
    expect(own).toBeGreaterThanOrEqual(1);
  });

  it("denies user B's update of user A device rows", async () => {
    const attacker = asGeneric(clientFor(userB.id));
    const affected = await updateRowCount(attacker, 'session_devices', [['user_id', userA.id]], {
      user_agent: 'tampered',
    });
    expect(affected).toBe(0);
  });

  it("fails the fingerprint gate when user B presents user A's fingerprint", async () => {
    await expect(
      fingerprintMiddleware()(contextFor(userB, fingerprintA), proceed),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('passes the fingerprint gate for the rightful owner', async () => {
    const res = await fingerprintMiddleware()(contextFor(userA, fingerprintA), proceed);
    expect(res.status).toBe(204);
  });
});
