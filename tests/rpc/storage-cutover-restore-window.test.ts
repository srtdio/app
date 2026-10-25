// storage_workspace_cutover(p_workspace_id, p_bucket, p_trace_id) and the
// 30-day workspace_purge_due window (20261026000000_storage_cutover_restore_window.sql).
//
// storage_workspace_cutover is service_role only: anon and authenticated are
// refused. It repoints a live workspace's asset_bucket under the
// sorted.storage_cutover flag, so the asset_bucket immutability trigger lets
// that one update through while a direct update still raises. The same bucket
// is a no-op; a real change writes an audit_log row carrying the trace id.
// workspace_purge_due lists a workspace soft-deleted 31 days ago, never one
// deleted 29 days ago (the restore window).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

const DAY_MS = 86_400_000;

interface WorkspaceRow {
  asset_bucket: string | null;
  row_version: number;
  deleted_at: string | null;
}

interface AuditRow {
  action: string;
  entity_id: string | null;
  payload: { from?: string | null; to?: string } | null;
  outcome: string;
  trace_id: string;
}

function bucketName(): string {
  return `cutover-${crypto.randomUUID().slice(0, 8)}`;
}

describe.runIf(RPC_SUITE)('storage_workspace_cutover and the workspace restore window', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  const workspaces: SeededWorkspace[] = [];

  async function workspaceRow(id: string): Promise<WorkspaceRow> {
    const res = await g
      .from('workspaces')
      .select('asset_bucket, row_version, deleted_at')
      .eq('id', id);
    if (res.error) throw new Error(`workspaces read failed: ${res.error.message}`);
    const row = ((res.data as WorkspaceRow[] | null) ?? [])[0];
    if (row === undefined) throw new Error(`no workspaces row for ${id}`);
    return row;
  }

  async function auditRows(workspaceId: string): Promise<AuditRow[]> {
    const res = await g
      .from('audit_log')
      .select('action, entity_id, payload, outcome, trace_id')
      .eq('workspace_id', workspaceId)
      .eq('action', 'storage_workspace_cutover');
    if (res.error) throw new Error(`audit_log read failed: ${res.error.message}`);
    return (res.data as AuditRow[] | null) ?? [];
  }

  /** Update a workspaces row as the service role, bumping row_version as the trigger demands. */
  async function updateWorkspace(
    id: string,
    values: Record<string, unknown>,
  ): Promise<{ message: string } | null> {
    const { row_version } = await workspaceRow(id);
    const res = await g
      .from('workspaces')
      .update({ ...values, row_version: row_version + 1 })
      .eq('id', id);
    return res.error;
  }

  async function seed(label: string): Promise<SeededWorkspace> {
    const ws = await seedWorkspace(admin, owner, `${label} ${owner.email}`);
    workspaces.push(ws);
    return ws;
  }

  function cutoverArgs(workspaceId: string, bucket: string, traceId = generateTraceId()) {
    return { p_workspace_id: workspaceId, p_bucket: bucket, p_trace_id: traceId };
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, [owner]);
  });

  it('refuses anon and authenticated callers, even the workspace owner', async () => {
    const ws = await seed('Cutover refused');
    const before = await workspaceRow(ws.id);
    const asAnon = await createAnonClient(loadRlsEnv()).rpc(
      'storage_workspace_cutover',
      cutoverArgs(ws.id, bucketName()),
    );
    expect(asAnon.error).not.toBeNull();
    const asOwner = await clientFor(owner.id).rpc(
      'storage_workspace_cutover',
      cutoverArgs(ws.id, bucketName()),
    );
    expect(asOwner.error).not.toBeNull();
    expect((await workspaceRow(ws.id)).asset_bucket).toBe(before.asset_bucket);
    expect(await auditRows(ws.id)).toEqual([]);
  });

  it('lets service_role repoint the bucket and writes an audit_log row with the trace id', async () => {
    const ws = await seed('Cutover ok');
    const before = await workspaceRow(ws.id);
    const bucket = bucketName();
    const traceId = generateTraceId();
    const res = await admin.rpc('storage_workspace_cutover', cutoverArgs(ws.id, bucket, traceId));
    expect(res.error).toBeNull();
    expect((await workspaceRow(ws.id)).asset_bucket).toBe(bucket);
    const audit = await auditRows(ws.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'storage_workspace_cutover',
      entity_id: ws.id,
      payload: { from: before.asset_bucket, to: bucket },
      outcome: 'success',
      trace_id: traceId,
    });
  });

  it('is a no-op for the bucket the workspace already has: no update, no audit row', async () => {
    const ws = await seed('Cutover same');
    const before = await workspaceRow(ws.id);
    const bucket = before.asset_bucket ?? bucketName();
    if (before.asset_bucket === null) {
      expect(
        (await admin.rpc('storage_workspace_cutover', cutoverArgs(ws.id, bucket))).error,
      ).toBeNull();
    }
    const settled = await workspaceRow(ws.id);
    const auditBefore = (await auditRows(ws.id)).length;
    const res = await admin.rpc('storage_workspace_cutover', cutoverArgs(ws.id, bucket));
    expect(res.error).toBeNull();
    const after = await workspaceRow(ws.id);
    expect(after.asset_bucket).toBe(bucket);
    expect(after.row_version).toBe(settled.row_version);
    expect(await auditRows(ws.id)).toHaveLength(auditBefore);
  });

  it('rejects a missing trace id, an invalid bucket name and a soft-deleted workspace', async () => {
    const ws = await seed('Cutover invalid');
    const noTrace = await admin.rpc('storage_workspace_cutover', {
      p_workspace_id: ws.id,
      p_bucket: bucketName(),
      p_trace_id: null as unknown as string,
    });
    expect(noTrace.error?.message).toContain('trace_id required');
    const badName = await admin.rpc('storage_workspace_cutover', cutoverArgs(ws.id, 'Bad_Name'));
    expect(badName.error?.message).toContain('invalid bucket');
    expect(await updateWorkspace(ws.id, { deleted_at: new Date().toISOString() })).toBeNull();
    const gone = await admin.rpc('storage_workspace_cutover', cutoverArgs(ws.id, bucketName()));
    expect(gone.error?.message).toContain('workspace not found');
  });

  it('still refuses a direct asset_bucket update outside the function', async () => {
    const ws = await seed('Cutover direct');
    // Give it a bucket through the function first, so the trigger has one to protect.
    expect(
      (await admin.rpc('storage_workspace_cutover', cutoverArgs(ws.id, bucketName()))).error,
    ).toBeNull();
    const before = await workspaceRow(ws.id);
    const error = await updateWorkspace(ws.id, { asset_bucket: bucketName() });
    expect(error?.message).toContain('asset_bucket is permanent and cannot be changed');
    expect((await workspaceRow(ws.id)).asset_bucket).toBe(before.asset_bucket);
  });

  it('workspace_purge_due lists a workspace deleted 31 days ago, not one deleted 29 days ago', async () => {
    const recent = await seed('Restore window 29d');
    const old = await seed('Restore window 31d');
    const now = Date.now();
    expect(
      await updateWorkspace(recent.id, { deleted_at: new Date(now - 29 * DAY_MS).toISOString() }),
    ).toBeNull();
    expect(
      await updateWorkspace(old.id, { deleted_at: new Date(now - 31 * DAY_MS).toISOString() }),
    ).toBeNull();
    const res = await admin.rpc('workspace_purge_due');
    expect(res.error).toBeNull();
    const ids = (res.data ?? []).map((row) => row.workspace_id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(recent.id);
  });
});
