// brief_reopen (20261023013000_brief_reopen.sql): any active member returns a
// closed brief to open. No capability check (product decision).
//
// - closed -> open clears closed_at and closed_by and bumps row_version by 1.
// - Open, deleted, or missing briefs raise invalid_payload.
// - Non-members and members of another workspace raise workspace_member_only.
// - Every other active member gets one system inbox row (payload.kind
//   brief_reopened, title, number); the actor gets one own row; inactive
//   members get none.
// - close, reopen, close again works.
// - One audit_log row with action brief_reopen per call.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  loadRlsEnv,
  randomSuffix,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

interface InboxRow {
  user_id: string;
  actor_user_id: string | null;
  event_type: string;
  entity_type: string | null;
  scope: string | null;
  payload: Record<string, unknown>;
}

interface BriefRow {
  status: string;
  closed_at: string | null;
  closed_by: string | null;
  row_version: number;
  title: string;
  number: number;
}

/** Typed pass-through for direct .rpc() args; each proc takes its own p_trace_id. */
function rpcArgs<T>(args: T): T {
  return args;
}

describe.runIf(RLS_SUITE)('brief_reopen', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let inactive: SeededUser;
  let outsider: SeededUser;
  let stranger: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;

  async function createBrief(user: SeededUser): Promise<string> {
    const res = await clientFor(user.id).rpc(
      'brief_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_payload: { title: `Brief ${randomSuffix()}`, objective: 'Launch the range' },
        p_trace_id: uuidv7(),
      }),
    );
    expect(res.error).toBeNull();
    return String(res.data);
  }

  async function close(user: SeededUser, briefId: string): Promise<void> {
    const res = await clientFor(user.id).rpc(
      'brief_close',
      rpcArgs({ p_brief_id: briefId, p_trace_id: uuidv7() }),
    );
    expect(res.error).toBeNull();
  }

  async function reopen(
    user: SeededUser,
    briefId: string,
    traceId: string = uuidv7(),
  ): Promise<{ error: { message: string } | null }> {
    return await clientFor(user.id).rpc(
      'brief_reopen',
      rpcArgs({ p_brief_id: briefId, p_trace_id: traceId }),
    );
  }

  async function brief(briefId: string): Promise<BriefRow> {
    const res = await admin
      .from('briefs')
      .select('status, closed_at, closed_by, row_version, title, number')
      .eq('id', briefId)
      .single();
    if (res.error) throw new Error(`brief read failed: ${res.error.message}`);
    return res.data as unknown as BriefRow;
  }

  /** Service-role ground truth: every brief_reopened row for one brief. */
  async function reopenedRows(briefId: string): Promise<InboxRow[]> {
    const res = await g
      .from('inbox_entries')
      .select('user_id, actor_user_id, event_type, entity_type, scope, payload')
      .eq('workspace_id', ws.id)
      .eq('entity_id', briefId)
      .eq('event_type', 'system');
    if (res.error) throw new Error(`inbox read failed: ${res.error.message}`);
    return ((res.data ?? []) as InboxRow[]).filter((r) => r.payload?.kind === 'brief_reopened');
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    client2 = await seedUser(env, admin);
    inactive = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    stranger = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Brief reopen ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Brief reopen other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    await seedMember(g, ws, inactive, 'client');
    const off = await g
      .from('workspace_members')
      .update({ active: false })
      .eq('workspace_id', ws.id)
      .eq('user_id', inactive.id);
    if (off.error) throw new Error(`deactivate failed: ${off.error.message}`);
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [ws, other],
      [owner, agency, client, client2, inactive, outsider, stranger],
    );
  });

  it('client member reopens a closed brief: open, closed_at and closed_by null, row_version +1', async () => {
    const briefId = await createBrief(client);
    await close(owner, briefId);
    const before = await brief(briefId);
    expect(before.status).toBe('closed');
    expect((await reopen(client, briefId)).error).toBeNull();
    const after = await brief(briefId);
    expect(after.status).toBe('open');
    expect(after.closed_at).toBeNull();
    expect(after.closed_by).toBeNull();
    expect(after.row_version).toBe(before.row_version + 1);
  });

  it('agency member reopens a closed brief', async () => {
    const briefId = await createBrief(client);
    await close(client, briefId);
    expect((await reopen(agency, briefId)).error).toBeNull();
    expect((await brief(briefId)).status).toBe('open');
  });

  it('reopening an open brief raises invalid_payload', async () => {
    const briefId = await createBrief(client);
    const before = await brief(briefId);
    const res = await reopen(owner, briefId);
    expect(res.error?.message).toContain('invalid_payload');
    expect((await brief(briefId)).row_version).toBe(before.row_version);
  });

  it('a deleted brief raises invalid_payload', async () => {
    const briefId = await createBrief(client);
    await close(owner, briefId);
    const del = await g
      .from('briefs')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', briefId);
    if (del.error) throw new Error(`soft delete failed: ${del.error.message}`);
    const res = await reopen(owner, briefId);
    expect(res.error?.message).toContain('invalid_payload');
    expect((await brief(briefId)).status).toBe('closed');
  });

  it('a missing brief raises invalid_payload', async () => {
    const res = await reopen(owner, uuidv7());
    expect(res.error?.message).toContain('invalid_payload');
  });

  it('non-member and cross-tenant callers raise workspace_member_only', async () => {
    const briefId = await createBrief(client);
    await close(owner, briefId);
    for (const caller of [stranger, outsider, inactive]) {
      const res = await reopen(caller, briefId);
      expect(res.error?.message).toContain('workspace_member_only');
    }
    expect((await brief(briefId)).status).toBe('closed');
    expect(other.id).not.toBe(ws.id);
  });

  it('every other active member gets one system entry; actor gets the self entry; inactive gets none', async () => {
    const briefId = await createBrief(client);
    await close(owner, briefId);
    expect((await reopen(client, briefId)).error).toBeNull();
    const b = await brief(briefId);
    const list = await reopenedRows(briefId);
    const othersList = list.filter((r) => r.user_id !== client.id);
    expect(othersList.map((r) => r.user_id).sort()).toEqual(
      [owner.id, agency.id, client2.id].sort(),
    );
    const self = list.filter((r) => r.user_id === client.id && r.actor_user_id === client.id);
    expect(self).toHaveLength(1);
    expect(list.some((r) => r.user_id === inactive.id)).toBe(false);
    for (const row of list) {
      expect(row.event_type).toBe('system');
      expect(row.entity_type).toBe('brief');
      expect(row.scope).toBe('briefs');
      expect(row.actor_user_id).toBe(client.id);
      expect(row.payload).toMatchObject({
        kind: 'brief_reopened',
        title: b.title,
        number: b.number,
        actor_role: 'client',
      });
    }
  });

  it('close, reopen, close again works', async () => {
    const briefId = await createBrief(client);
    await close(owner, briefId);
    expect((await reopen(agency, briefId)).error).toBeNull();
    await close(client, briefId);
    const after = await brief(briefId);
    expect(after.status).toBe('closed');
    expect(after.closed_by).toBe(client.id);
    expect(after.closed_at).not.toBeNull();
  });

  it('writes one brief_reopen audit row', async () => {
    const briefId = await createBrief(client);
    await close(owner, briefId);
    const traceId = uuidv7();
    expect((await reopen(owner, briefId, traceId)).error).toBeNull();
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', traceId],
        ['action', 'brief_reopen'],
      ]),
    ).toBe(1);
  });
});
