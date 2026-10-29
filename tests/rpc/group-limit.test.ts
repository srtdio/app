// One chat group per workspace on the free plan (20261029120000_group_limit.sql),
// exercised as the AUTHENTICATED role. group_create raises 'group_limit_reached'
// once a workspace holds group_allowance non-deleted groups; raising the
// allowance (service role, row_version bump) lets exactly that many more in.
// A workspace whose owner is an active platform operator is unlimited, and an
// induction sample group (induction_sample_rows kind='group') never counts.
// capabilities_for_workspace answers the same rule as 'group.create_more';
// a non-member gets false.
//
// seedWorkspace inserts the workspace directly (no default group), so the
// first group_create here is the workspace's one free group.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  seedMember,
  seedOperator,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

type CreateArgs = Database['public']['Functions']['group_create']['Args'];

let groupSeq = 0;
function createArgs(workspaceId: string): CreateArgs {
  groupSeq += 1;
  return {
    p_workspace_id: workspaceId,
    p_name: `Limit group ${groupSeq}`,
    p_member_user_ids: [],
    p_trace_id: generateTraceId(),
  };
}

type CapsArgs = Database['public']['Functions']['capabilities_for_workspace']['Args'];

function capsArgs(workspaceId: string): CapsArgs {
  return { p_trace_id: generateTraceId(), p_workspace_id: workspaceId };
}

describe.runIf(RPC_SUITE)('group limit: group_create and group.create_more', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let member: SeededUser;
  let outsider: SeededUser;
  let operator: SeededUser;
  // A second owner: the free plan allows one owned workspace per person.
  let sampleOwner: SeededUser;
  let ws: SeededWorkspace;
  let opWs: SeededWorkspace;
  let sampleWs: SeededWorkspace;

  function create(as: SeededUser, workspaceId: string) {
    return clientFor(as.id).rpc('group_create', createArgs(workspaceId));
  }

  async function canCreateMore(as: SeededUser, workspaceId: string): Promise<boolean | null> {
    const res = await clientFor(as.id).rpc('capabilities_for_workspace', capsArgs(workspaceId));
    if (res.error) throw new Error(`capabilities_for_workspace failed: ${res.error.message}`);
    const row = (res.data ?? []).find((r) => r.capability === 'group.create_more');
    return row === undefined ? null : row.allowed;
  }

  // Service role, as the ops note does it: allowance plus a row_version bump.
  async function setAllowance(workspaceId: string, allowance: number): Promise<void> {
    const read = await admin.from('workspaces').select('row_version').eq('id', workspaceId);
    if (read.error) throw new Error(`workspaces read failed: ${read.error.message}`);
    const version = Number(read.data?.[0]?.row_version ?? 1);
    const res = await admin
      .from('workspaces')
      .update({ group_allowance: allowance, row_version: version + 1 })
      .eq('id', workspaceId);
    if (res.error) throw new Error(`group_allowance update failed: ${res.error.message}`);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    member = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    operator = await seedUser(env, admin);
    sampleOwner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Group limit ${owner.email}`);
    await seedMember(g, ws, member, 'agency');
    await seedOperator(g, operator);
    opWs = await seedWorkspace(admin, operator, `Group limit op ${operator.email}`);
    sampleWs = await seedWorkspace(admin, sampleOwner, `Group limit sample ${sampleOwner.email}`);
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [ws, opWs, sampleWs],
      [owner, member, outsider, operator, sampleOwner],
    );
  });

  it('a fresh workspace has room for its one group, then refuses a second', async () => {
    expect(await canCreateMore(owner, ws.id)).toBe(true);
    const first = await create(owner, ws.id);
    expect(first.error).toBeNull();

    expect(await canCreateMore(owner, ws.id)).toBe(false);
    expect(await canCreateMore(member, ws.id)).toBe(false);
    const second = await create(member, ws.id);
    expect(second.error?.message).toContain('group_limit_reached');
  });

  it('a raised allowance lets exactly that many in; the next one is refused', async () => {
    await setAllowance(ws.id, 2);
    expect(await canCreateMore(owner, ws.id)).toBe(true);
    const second = await create(owner, ws.id);
    expect(second.error).toBeNull();

    expect(await canCreateMore(owner, ws.id)).toBe(false);
    const third = await create(owner, ws.id);
    expect(third.error?.message).toContain('group_limit_reached');
  });

  it('the allowance never goes below 1', async () => {
    // row_version bumps by 1 so only the allowance check can refuse the write.
    const read = await admin.from('workspaces').select('row_version').eq('id', ws.id);
    expect(read.error).toBeNull();
    const version = Number(read.data?.[0]?.row_version ?? 1);
    const res = await admin
      .from('workspaces')
      .update({ group_allowance: 0, row_version: version + 1 })
      .eq('id', ws.id);
    expect(res.error?.message).toContain('workspaces_group_allowance_min');
  });

  it('an operator-owned workspace is unlimited', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await create(operator, opWs.id);
      expect(res.error).toBeNull();
    }
    expect(await canCreateMore(operator, opWs.id)).toBe(true);
  });

  it('an induction sample group never counts', async () => {
    const sample = await insertRow(g, 'groups', {
      workspace_id: sampleWs.id,
      name: 'Sample group',
      created_by: sampleOwner.id,
    });
    await insertRow(g, 'induction_sample_rows', {
      workspace_id: sampleWs.id,
      kind: 'group',
      row_id: String(sample.id),
    });
    expect(await canCreateMore(sampleOwner, sampleWs.id)).toBe(true);
    const own = await create(sampleOwner, sampleWs.id);
    expect(own.error).toBeNull();
    const next = await create(sampleOwner, sampleWs.id);
    expect(next.error?.message).toContain('group_limit_reached');
  });

  it('a non-member gets group.create_more false and cannot create', async () => {
    expect(await canCreateMore(outsider, opWs.id)).toBe(false);
    const res = await create(outsider, opWs.id);
    expect(res.error?.message).toContain('workspace_member_only');
  });

  it('the new row leaves every other capability as it was', async () => {
    const res = await clientFor(member.id).rpc('capabilities_for_workspace', capsArgs(ws.id));
    expect(res.error).toBeNull();
    const rows = res.data ?? [];
    expect(rows.filter((r) => r.capability === 'group.create_more')).toHaveLength(1);
    const roleRows = await admin
      .from('workspace_role_permissions')
      .select('capability, allowed')
      .eq('workspace_id', ws.id)
      .eq('role', 'agency');
    expect(roleRows.error).toBeNull();
    const others = rows.filter((r) => r.capability !== 'group.create_more');
    expect(others.length).toBe((roleRows.data ?? []).length);
  });
});
