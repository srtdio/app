// The service_role bypasses RLS by design (BYPASSRLS) so operational tooling can
// read across every workspace. This is EXPECTED BEHAVIOUR, not a leak: the
// service key is server-only and never shipped to clients. This test documents
// and pins that contract.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  createAdminClient,
  loadRlsEnv,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

describe.runIf(RLS_SUITE)('service_role bypasses RLS (expected, ops-only)', () => {
  let admin: SupabaseClient<Database>;
  let adminGeneric: GenericClient;
  let userA: SeededUser;
  let userB: SeededUser;
  let workspaceA: SeededWorkspace;
  let workspaceB: SeededWorkspace;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    userA = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    workspaceA = await seedWorkspace(admin, userA, `Svc A ${userA.email}`);
    workspaceB = await seedWorkspace(admin, userB, `Svc B ${userB.email}`);
    await seedScaffold(admin, workspaceA);
    await seedScaffold(admin, workspaceB);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [workspaceA, workspaceB], [userA, userB]);
  });

  it('reads both workspaces (cross-tenant, as intended for ops)', async () => {
    const a = await adminGeneric.from('workspaces').select('*').eq('id', workspaceA.id);
    const b = await adminGeneric.from('workspaces').select('*').eq('id', workspaceB.id);
    expect((a.data as unknown[] | null)?.length ?? 0).toBe(1);
    expect((b.data as unknown[] | null)?.length ?? 0).toBe(1);
  });

  it('sees posts from both tenants in a single query', async () => {
    const res = await adminGeneric
      .from('posts')
      .select('workspace_id')
      .eq('workspace_id', workspaceA.id);
    const aPosts = (res.data as unknown[] | null)?.length ?? 0;
    const resB = await adminGeneric
      .from('posts')
      .select('workspace_id')
      .eq('workspace_id', workspaceB.id);
    const bPosts = (resB.data as unknown[] | null)?.length ?? 0;
    expect(aPosts).toBeGreaterThanOrEqual(1);
    expect(bPosts).toBeGreaterThanOrEqual(1);
  });
});
