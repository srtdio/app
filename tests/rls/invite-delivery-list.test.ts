// invite_delivery_list (20261023103000_invite_delivery_list.sql), recorded from live.
// Read-only: the latest member_invite delivery status per pending invite. Only an active
// member of the workspace gets rows; a member of another workspace gets none; anon cannot
// execute it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  createAnonClient,
  insertRow,
  loadRlsEnv,
  randomSuffix,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/**
 * Typed pass-through for direct .rpc() args. invite_delivery_list takes no trace id
 * (read-only). callRpc() is the app wrapper and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

interface DeliveryRow {
  member_id: string;
  status: string;
  status_at: string;
}

describe.runIf(RLS_SUITE)('invite_delivery_list', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let ownerA: SeededUser;
  let ownerB: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let pendingMemberId: string;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];

  async function list(client: SupabaseClient<Database>, wsId: string) {
    return await client.rpc('invite_delivery_list', rpcArgs({ p_workspace_id: wsId }));
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    ownerA = await seedUser(env, admin);
    ownerB = await seedUser(env, admin);
    users.push(ownerA, ownerB);
    wsA = await seedWorkspace(admin, ownerA, `IDL A ${randomSuffix()}`);
    wsB = await seedWorkspace(admin, ownerB, `IDL B ${randomSuffix()}`);
    workspaces.push(wsA, wsB);

    // Pending invite in A: inactive, not accepted, not removed.
    const invitee = await seedUser(env, admin);
    users.push(invitee);
    const member = await insertRow(g, 'workspace_members', {
      workspace_id: wsA.id,
      user_id: invitee.id,
      role: 'agency',
      active: false,
      invited_by: ownerA.id,
    });
    pendingMemberId = String(member.id);

    // Two attempts; the later one (delivered) is the one reported.
    await insertRow(g, 'delivery_attempts', {
      workspace_id: wsA.id,
      user_id: invitee.id,
      channel: 'email',
      template_key: 'member_invite',
      provider: 'resend',
      status: 'sent',
      sent_at: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 20));
    await insertRow(g, 'delivery_attempts', {
      workspace_id: wsA.id,
      user_id: invitee.id,
      channel: 'email',
      template_key: 'member_invite',
      provider: 'resend',
      status: 'delivered',
      sent_at: new Date().toISOString(),
      delivered_at: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  it("returns the latest status for a member of A's pending invites", async () => {
    const res = await list(clientFor(ownerA.id), wsA.id);
    expect(res.error).toBeNull();
    const rows = (res.data ?? []) as DeliveryRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.member_id).toBe(pendingMemberId);
    expect(rows[0]?.status).toBe('delivered');
    expect(rows[0]?.status_at).toBeTruthy();
  });

  it("returns zero rows to a member of B calling with A's id", async () => {
    const res = await list(clientFor(ownerB.id), wsA.id);
    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it('refuses anon execute', async () => {
    const res = await list(createAnonClient(env), wsA.id);
    expect(res.error).not.toBeNull();
    expect(res.data).toBeNull();
  });
});
