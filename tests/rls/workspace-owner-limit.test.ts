// One active workspace per owner on the free plan
// (20261016000000_workspace_owner_limit.sql). The workspaces_owner_limit trigger
// runs before insert or update of owner_user_id: a second active workspace for
// the same owner raises workspace_limit_reached, an active platform_operators
// row is exempt, and an owner transfer to someone who already owns one is
// blocked.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  loadRlsEnv,
  seedOperator,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/** Typed pass-through for direct .rpc() args; each call sets its own p_trace_id. */
function rpcArgs<T>(args: T): T {
  return args;
}

describe.runIf(RLS_SUITE)('workspace owner limit', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];

  async function create(user: SeededUser, name: string) {
    const res = await clientFor(user.id).rpc(
      'workspace_create',
      rpcArgs({
        p_payload: { name, timezone: 'UTC', platform: 'linkedin' },
        p_trace_id: uuidv7(),
      }),
    );
    if (res.error === null) workspaces.push({ id: String(res.data), name, ownerId: user.id });
    return res;
  }

  async function newUser(): Promise<SeededUser> {
    const user = await seedUser(env, admin);
    users.push(user);
    return user;
  }

  beforeAll(() => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  it('refuses a second workspace for the same owner (workspace_limit_reached)', async () => {
    const owner = await newUser();
    const first = await create(owner, 'Limit One');
    expect(first.error).toBeNull();

    const second = await create(owner, 'Limit Two');
    expect(second.error?.message).toBe('workspace_limit_reached');

    const owned = await admin
      .from('workspaces')
      .select('id')
      .eq('owner_user_id', owner.id)
      .is('deleted_at', null);
    expect(owned.error).toBeNull();
    expect(owned.data).toHaveLength(1);
  });

  it('lets an active platform operator own a second workspace', async () => {
    const operator = await newUser();
    await seedOperator(asGeneric(admin), operator);

    expect((await create(operator, 'Operator One')).error).toBeNull();
    expect((await create(operator, 'Operator Two')).error).toBeNull();
  });

  it('blocks an owner transfer to someone who already owns a workspace', async () => {
    const holder = await newUser();
    const other = await newUser();
    workspaces.push(await seedWorkspace(admin, holder, 'Transfer Held'));
    const moving = await seedWorkspace(admin, other, 'Transfer Moving');
    workspaces.push(moving);

    const cur = await admin.from('workspaces').select('row_version').eq('id', moving.id).single();
    if (cur.error) throw new Error(cur.error.message);
    const res = await admin
      .from('workspaces')
      .update({ owner_user_id: holder.id, row_version: cur.data.row_version + 1 })
      .eq('id', moving.id);
    expect(res.error?.message).toBe('workspace_limit_reached');

    const row = await admin.from('workspaces').select('owner_user_id').eq('id', moving.id).single();
    expect(row.data?.owner_user_id).toBe(other.id);
  });
});
