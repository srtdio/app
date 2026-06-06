// Cross-tenant isolation: for every tenant-scoped table, a user in workspace B
// must not be able to read, update, or delete workspace A's rows.
//
// Per the project's RLS model the authenticated role has no write policies on
// these tables and the membership SELECT policy is self-referential, so we seed
// through the service role (the privileged path) and assert isolation against
// service-role ground truth. See packages/test-utils/rls.ts for the rationale.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  clientFor,
  cleanupWorkspaces,
  countWhere,
  createAdminClient,
  deleteRowCount,
  loadRlsEnv,
  seedScaffold,
  seedUser,
  seedWorkspace,
  tenantTables,
  updateRowCount,
  visibleRowCount,
  type Ctx,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

describe.runIf(RLS_SUITE)('cross-tenant RLS isolation', () => {
  let admin: SupabaseClient<Database>;
  let adminGeneric: GenericClient;
  let userA: SeededUser;
  let userB: SeededUser;
  let workspaceA: SeededWorkspace;
  let workspaceB: SeededWorkspace;
  let ctxA: Ctx;
  let attacker: GenericClient;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    userA = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    workspaceA = await seedWorkspace(admin, userA, `A ${userA.email}`);
    workspaceB = await seedWorkspace(admin, userB, `B ${userB.email}`);
    ctxA = await seedScaffold(admin, workspaceA);

    // User B is the cross-tenant attacker for every case.
    attacker = asGeneric(clientFor(userB.id));
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [workspaceA, workspaceB], [userA, userB]);
  });

  it.each(tenantTables)('isolates $table across workspaces', async (probe) => {
    const { match, patch } = await probe.seed(adminGeneric, ctxA);

    // (a) the workspace-A row exists (seeded via the privileged path).
    expect(await countWhere(adminGeneric, probe.table, match)).toBeGreaterThanOrEqual(1);

    // (b) user B cannot read workspace A's row.
    expect(await visibleRowCount(attacker, probe.table, match)).toBe(0);

    // (c) user B's update affects 0 rows.
    if (Object.keys(patch).length > 0) {
      expect(await updateRowCount(attacker, probe.table, match, patch)).toBe(0);
    }

    // (d) user B's delete affects 0 rows.
    expect(await deleteRowCount(attacker, probe.table, match)).toBe(0);

    // The row is untouched by B's write attempts (ground truth via service role).
    expect(await countWhere(adminGeneric, probe.table, match)).toBeGreaterThanOrEqual(1);
  });
});
