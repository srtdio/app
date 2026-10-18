// Grant posture: inbox_entry_create has NO EXECUTE grant to the authenticated
// role (server / service-role callers only). Even a legitimate active member,
// acting as the authenticated role, must be rejected when calling it directly -
// proving the lockdown is the grant, not just the membership gate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  createAnonClient,
  generateTraceId,
  loadRlsEnv,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';

/** A structural rpc surface, so the nullable p_scope_key is accepted as given. */
interface RpcClient {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

const INBOX_SUITE = process.env.INBOX_SUITE === '1';

describe.runIf(INBOX_SUITE)('inbox_entry_create grant check', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let ws: SeededWorkspace;

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    owner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Grant ${owner.email}`);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner]);
  });

  it('the authenticated role cannot call inbox_entry_create', async () => {
    // Call through the structural RpcClient so the (deliberately nullable)
    // p_scope_key argument is accepted; the generated Args type marks it
    // non-null, but the proc accepts null at runtime.
    const authed = clientFor(owner.id) as unknown as RpcClient;
    const params: Record<string, unknown> = {
      p_user_id: owner.id,
      p_workspace_id: ws.id,
      p_event_type: 'system',
      p_entity_type: 'workspace',
      p_entity_id: ws.id,
      p_scope: 'everything',
      p_scope_key: null,
      p_tier: 'active',
      p_payload: {},
      p_trace_id: generateTraceId(),
    };
    const { data, error } = await authed.rpc('inbox_entry_create', params);

    expect(data).toBeNull();
    expect(error).not.toBeNull();

    // And nothing was written for that workspace.
    const res = await asGeneric(admin).from('inbox_entries').select('id').eq('workspace_id', ws.id);
    expect((res.data as unknown[] | null)?.length ?? 0).toBe(0);
  });

  it('the anon role cannot call inbox_entry_create either', async () => {
    const anon = createAnonClient(env) as unknown as RpcClient;
    const params: Record<string, unknown> = {
      p_user_id: owner.id,
      p_workspace_id: ws.id,
      p_event_type: 'system',
      p_entity_type: 'workspace',
      p_entity_id: ws.id,
      p_scope: 'everything',
      p_scope_key: null,
      p_tier: 'active',
      p_payload: {},
      p_trace_id: generateTraceId(),
    };
    const { error } = await anon.rpc('inbox_entry_create', params);
    expect(error).not.toBeNull();
    const res = await asGeneric(admin).from('inbox_entries').select('id').eq('workspace_id', ws.id);
    expect((res.data as unknown[] | null)?.length ?? 0).toBe(0);
  });
});
