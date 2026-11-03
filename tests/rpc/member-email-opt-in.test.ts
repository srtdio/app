// member_email_opt_in_set and the users_email_opt_out_by_trg trigger, as the
// AUTHENTICATED role. An owner/admin of a live workspace the target is active
// in switches the target's catch-up emails off/on; users.email_opt_out_by
// records the manager. A person's own switch (user_profile_update) leaves it
// NULL, and a manager may not switch that back on (turned_off_by_member).
//
// The service-role admin client only seeds members and reads back ground
// truth (users, audit_log). No teardown: the fixtures live in their own
// workspaces.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  createAdminClient,
  loadRlsEnv,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

type Db = SupabaseClient<Database>;

describe.runIf(RPC_SUITE)('member_email_opt_in_set (authenticated role)', () => {
  let admin: Db;
  let g: GenericClient;
  let owner: SeededUser;
  let adminUser: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let member: SeededUser;
  let otherOwner: SeededUser;
  let onlyB: SeededUser;
  let wsA: SeededWorkspace;

  async function setOptIn(caller: SeededUser, userId: string, value: boolean, traceId = uuidv7()) {
    const args = { p_user_id: userId, p_email_opt_in: value, p_trace_id: traceId };
    return clientFor(caller.id).rpc('member_email_opt_in_set', args);
  }

  async function selfSet(user: SeededUser, value: boolean) {
    const row = await admin.from('users').select('display_name').eq('id', user.id).single();
    if (row.error) throw new Error(row.error.message);
    const args = {
      p_display_name: row.data.display_name,
      p_designation: null as unknown as string,
      p_avatar_url: null as unknown as string,
      p_email_opt_in: value,
      p_trace_id: uuidv7(),
    };
    const res = await clientFor(user.id).rpc('user_profile_update', args);
    if (res.error) throw new Error(`user_profile_update failed: ${res.error.message}`);
  }

  async function readUser(userId: string) {
    const res = await admin
      .from('users')
      .select('email_opt_in, email_opt_out_by')
      .eq('id', userId)
      .single();
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }

  async function auditRows(traceId: string) {
    const res = await admin
      .from('audit_log')
      .select('action, actor_user_id, entity_id, payload, workspace_id')
      .eq('trace_id', traceId)
      .eq('action', 'member_email_opt_in_set');
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }

  /** Reset the member to on with no manager recorded. */
  async function resetOn(user: SeededUser) {
    await admin.from('users').update({ email_opt_in: true }).eq('id', user.id);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    adminUser = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    member = await seedUser(env, admin);
    otherOwner = await seedUser(env, admin);
    onlyB = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Email opt A ${owner.email}`);
    await seedMember(g, wsA, adminUser, 'admin');
    await seedMember(g, wsA, agency, 'agency');
    await seedMember(g, wsA, client, 'client');
    await seedMember(g, wsA, member, 'client');
    const wsB = await seedWorkspace(admin, otherOwner, `Email opt B ${otherOwner.email}`);
    await seedMember(g, wsB, onlyB, 'client');
  });

  beforeEach(async () => {
    await resetOn(member);
  });

  it('admin turns a member off: false, by = admin, audit row written', async () => {
    const traceId = uuidv7();
    const res = await setOptIn(adminUser, member.id, false, traceId);
    expect(res.error).toBeNull();
    expect(res.data).toBe(traceId);
    expect(await readUser(member.id)).toEqual({
      email_opt_in: false,
      email_opt_out_by: adminUser.id,
    });
    const rows = await auditRows(traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: adminUser.id,
      entity_id: member.id,
      workspace_id: wsA.id,
      payload: { email_opt_in: false },
    });
  });

  it('admin turns it back on: true, by NULL', async () => {
    expect((await setOptIn(owner, member.id, false)).error).toBeNull();
    const res = await setOptIn(adminUser, member.id, true);
    expect(res.error).toBeNull();
    expect(await readUser(member.id)).toEqual({ email_opt_in: true, email_opt_out_by: null });
  });

  it('member turned off via user_profile_update: by NULL; admin switch-on fails turned_off_by_member', async () => {
    await selfSet(member, false);
    expect(await readUser(member.id)).toEqual({ email_opt_in: false, email_opt_out_by: null });
    const res = await setOptIn(adminUser, member.id, true);
    expect(res.error?.message).toBe('turned_off_by_member');
    expect(await readUser(member.id)).toEqual({ email_opt_in: false, email_opt_out_by: null });
  });

  it('member switches self back on via user_profile_update after a manager turned it off', async () => {
    expect((await setOptIn(adminUser, member.id, false)).error).toBeNull();
    await selfSet(member, true);
    expect(await readUser(member.id)).toEqual({ email_opt_in: true, email_opt_out_by: null });
  });

  it('agency and client callers are forbidden', async () => {
    for (const caller of [agency, client]) {
      const res = await setOptIn(caller, member.id, false);
      expect(res.error?.message).toBe('forbidden');
    }
    expect(await readUser(member.id)).toEqual({ email_opt_in: true, email_opt_out_by: null });
  });

  it('owner of workspace A cannot reach a target only in workspace B', async () => {
    const res = await setOptIn(owner, onlyB.id, false);
    expect(res.error?.message).toBe('forbidden');
    expect(await readUser(onlyB.id)).toEqual({ email_opt_in: true, email_opt_out_by: null });
  });

  it('a target removed from the shared workspace is forbidden', async () => {
    const env = loadRlsEnv();
    const removed = await seedUser(env, admin);
    await seedMember(g, wsA, removed, 'client');
    await admin
      .from('workspace_members')
      .update({ active: false, removed_at: new Date().toISOString() })
      .eq('workspace_id', wsA.id)
      .eq('user_id', removed.id);
    const res = await setOptIn(owner, removed.id, false);
    expect(res.error?.message).toBe('forbidden');
  });

  it('p_user_id = caller raises use_own_settings', async () => {
    const res = await setOptIn(adminUser, adminUser.id, false);
    expect(res.error?.message).toBe('use_own_settings');
  });

  it('no-op when the value already matches: returns the trace id, no audit row', async () => {
    const traceId = uuidv7();
    const res = await setOptIn(adminUser, member.id, true, traceId);
    expect(res.error).toBeNull();
    expect(res.data).toBe(traceId);
    expect(await auditRows(traceId)).toHaveLength(0);
  });

  it('authenticated cannot UPDATE users.email_opt_out_by directly', async () => {
    const res = await clientFor(member.id)
      .from('users')
      .update({ email_opt_out_by: owner.id })
      .eq('id', member.id)
      .select('id');
    // Live has no UPDATE grant (a privilege error); the local container keeps
    // Supabase's default table grants, so the write may go through RLS. Either
    // way the trigger keeps the old value: nothing is ever stored.
    expect(res.error === null || res.error.code === '42501').toBe(true);
    expect(await readUser(member.id)).toEqual({ email_opt_in: true, email_opt_out_by: null });
  });
});
