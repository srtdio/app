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
  generateTraceId,
  loadRlsEnv,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import {
  createActingClient,
  writeInboxEntry,
  type RpcClient,
} from '../../packages/inbox/src/index';
import { LOCAL_JWT_SECRET } from './helpers';

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

  it('the service role, acting as an active member, CAN call it (control)', async () => {
    // The privileged path the worker uses: a service_role token carrying an
    // active member's sub satisfies both the EXECUTE grant and the membership
    // gate. This must succeed where the authenticated call above failed.
    const writer = (await createActingClient({
      url: env.url,
      serviceKey: env.serviceKey,
      jwtSecret: LOCAL_JWT_SECRET,
      actingUserId: owner.id,
    })) as unknown as RpcClient;
    const id = await writeInboxEntry(writer, {
      userId: owner.id,
      workspaceId: ws.id,
      eventType: 'comment',
      entityType: 'workspace',
      entityId: ws.id,
      scope: 'everything',
      scopeKey: null,
      tier: 'active',
      payload: {},
      traceId: generateTraceId(),
    });
    expect(typeof id).toBe('string');

    const res = await asGeneric(admin).from('inbox_entries').select('id').eq('workspace_id', ws.id);
    expect((res.data as unknown[] | null)?.length ?? 0).toBeGreaterThan(0);
  });
});
