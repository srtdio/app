// The anon role must not read any tenant-scoped table. All RLS policies on these
// tables target the `authenticated` role, so anon falls through to default-deny
// and every SELECT returns zero rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  createAdminClient,
  createAnonClient,
  loadRlsEnv,
  seedScaffold,
  seedUser,
  seedWorkspace,
  tenantTables,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

describe.runIf(RLS_SUITE)('anon role is denied on tenant tables', () => {
  let admin: SupabaseClient<Database>;
  let anon: GenericClient;
  let owner: SeededUser;
  let workspace: SeededWorkspace;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    anon = asGeneric(createAnonClient(env));

    // Seed real data so a passing test means "RLS hid it", not "table is empty".
    owner = await seedUser(env, admin);
    workspace = await seedWorkspace(admin, owner, `Anon ${owner.email}`);
    const ctx = await seedScaffold(admin, workspace);
    for (const probe of tenantTables) {
      await probe.seed(asGeneric(admin), ctx);
    }
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [workspace], [owner]);
  });

  it.each(tenantTables)('blocks anon SELECT on $table', async (probe) => {
    const res = await anon.from(probe.table).select('*', { count: 'exact', head: true });
    // Either an explicit error or a zero count is acceptable; both mean no rows.
    expect(res.count ?? 0).toBe(0);
  });
});
