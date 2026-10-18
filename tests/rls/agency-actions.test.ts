// Agency acts on behalf of client + who-did-what in Activity
// (20261007100000_agency_actions_activity.sql). stage_transition: the agency
// approves, rejects and parks; the client may only approve or reject (never park
// or send back to review). The stage_change payload carries actor_role.
// post_soft_delete: agency may delete a post (one post_deleted row per other
// member, none for the actor); the client may not. asset_delete(_many): any
// member, ONE assets_deleted row per other member per call; a repeat delete of
// the same ids writes nothing. A member of another workspace gets nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  randomSuffix,
  seedAsset,
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

interface RpcResult {
  error: { message: string } | null;
}

interface InboxRow {
  user_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  scope: string;
  scope_key: string | null;
  tier: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * Typed pass-through for direct .rpc() args. Each proc here takes its own
 * p_trace_id (a uuid v7, set at every call site). callRpc() is the app wrapper
 * and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

describe.runIf(RLS_SUITE)('agency actions on behalf of client', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let bucketId: string;

  async function seedPost(stage: string): Promise<{ id: string; number: number; title: string }> {
    const number = await nextEntityNumber(g, ws.id);
    const title = `Post ${randomSuffix()}`;
    const post = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number,
      title,
      bucket_id: bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage,
      created_by: owner.id,
    });
    return { id: String(post.id), number, title };
  }

  async function move(user: SeededUser, postId: string, to: string): Promise<RpcResult> {
    return await clientFor(user.id).rpc(
      'stage_transition',
      rpcArgs({ p_post_id: postId, p_to_stage: to, p_trace_id: uuidv7() }),
    );
  }

  async function deletePost(user: SeededUser, postId: string): Promise<RpcResult> {
    return await clientFor(user.id).rpc(
      'post_soft_delete',
      rpcArgs({ p_post_id: postId, p_trace_id: uuidv7() }),
    );
  }

  async function deleteAsset(user: SeededUser, assetId: string): Promise<RpcResult> {
    return await clientFor(user.id).rpc(
      'asset_delete',
      rpcArgs({ p_asset_id: assetId, p_trace_id: uuidv7() }),
    );
  }

  async function deleteAssets(user: SeededUser, assetIds: string[]): Promise<RpcResult> {
    return await clientFor(user.id).rpc(
      'asset_delete_many',
      rpcArgs({ p_asset_ids: assetIds, p_trace_id: uuidv7() }),
    );
  }

  /** Service-role ground truth: inbox rows of one type in a workspace. */
  async function inbox(workspaceId: string, eventType: string): Promise<InboxRow[]> {
    const res = await g
      .from('inbox_entries')
      .select(
        'user_id, event_type, entity_type, entity_id, scope, scope_key, tier, actor_user_id, payload',
      )
      .eq('workspace_id', workspaceId)
      .eq('event_type', eventType);
    if (res.error) throw new Error(`inbox read failed: ${res.error.message}`);
    // Notification rows only: the actor's own already-read row
    // (20261018140000, inbox_self_entry) is asserted in activity-own-and-brief.test.ts.
    return ((res.data ?? []) as InboxRow[]).filter((row) => row.user_id !== row.actor_user_id);
  }

  async function inboxFor(entityId: string, eventType: string): Promise<InboxRow[]> {
    return (await inbox(ws.id, eventType)).filter((row) => row.entity_id === entityId);
  }

  async function stageOf(postId: string): Promise<string> {
    const res = await g.from('posts').select('stage').eq('id', postId);
    if (res.error) throw new Error(`posts read failed: ${res.error.message}`);
    return String((res.data as { stage: string }[])[0]?.stage);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Agency actions ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Agency actions other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws, other], [owner, agency, client, outsider]);
  });

  describe('stage_transition', () => {
    it('agency approves, rejects and parks', async () => {
      const a = await seedPost('review');
      expect((await move(agency, a.id, 'approved')).error).toBeNull();
      expect(await stageOf(a.id)).toBe('approved');
      expect((await move(agency, a.id, 'rejected')).error).toBeNull();
      expect(await stageOf(a.id)).toBe('rejected');
      const b = await seedPost('review');
      expect((await move(agency, b.id, 'parked')).error).toBeNull();
      expect(await stageOf(b.id)).toBe('parked');
    });

    it('client cannot park or move to review', async () => {
      const a = await seedPost('review');
      expect((await move(client, a.id, 'parked')).error?.message).toBe('forbidden_role');
      const b = await seedPost('rejected');
      expect((await move(client, b.id, 'review')).error?.message).toBe('forbidden_role');
      expect(await stageOf(a.id)).toBe('review');
      expect(await stageOf(b.id)).toBe('rejected');
    });

    it('client approves and rejects', async () => {
      const a = await seedPost('review');
      expect((await move(client, a.id, 'approved')).error).toBeNull();
      expect((await move(client, a.id, 'rejected')).error).toBeNull();
    });

    it('stage_change payload carries actor_role, actor_user_id is the actor', async () => {
      const a = await seedPost('review');
      expect((await move(agency, a.id, 'approved')).error).toBeNull();
      const rows = await inboxFor(a.id, 'stage_change');
      expect(rows.map((r) => r.user_id).sort()).toEqual([owner.id, client.id].sort());
      for (const row of rows) {
        expect(row.actor_user_id).toBe(agency.id);
        expect(row.payload).toMatchObject({ from: 'review', to: 'approved', actor_role: 'agency' });
      }
    });
  });

  describe('post_soft_delete', () => {
    it('agency deletes a post: one post_deleted row per other member, none for the actor', async () => {
      const p = await seedPost('review');
      expect((await deletePost(agency, p.id)).error).toBeNull();
      const rows = await inboxFor(p.id, 'post_deleted');
      expect(rows.map((r) => r.user_id).sort()).toEqual([owner.id, client.id].sort());
      expect(rows.some((r) => r.user_id === agency.id)).toBe(false);
      for (const row of rows) {
        expect(row).toMatchObject({
          entity_type: 'post',
          scope: 'posts',
          tier: 'active',
          actor_user_id: agency.id,
        });
        expect(row.payload).toMatchObject({
          number: p.number,
          title: p.title,
          actor_role: 'agency',
        });
      }
    });

    it('client cannot delete a post', async () => {
      const p = await seedPost('review');
      expect((await deletePost(client, p.id)).error?.message).toBe('forbidden_role');
      expect(await inboxFor(p.id, 'post_deleted')).toHaveLength(0);
    });
  });

  describe('asset_delete / asset_delete_many', () => {
    it('client deletes one asset: one assets_deleted row per other member', async () => {
      // The first asset delete in this workspace, and the only one by the client.
      const asset = await seedAsset(g, ws.id, owner.id);
      expect((await deleteAsset(client, asset.assetId)).error).toBeNull();
      const rows = (await inbox(ws.id, 'assets_deleted')).filter(
        (r) => r.actor_user_id === client.id,
      );
      expect(rows.map((r) => r.user_id).sort()).toEqual([owner.id, agency.id].sort());
      for (const row of rows) {
        expect(row).toMatchObject({
          entity_type: 'workspace',
          entity_id: ws.id,
          scope_key: ws.id,
          scope: 'everything',
          tier: 'active',
          actor_user_id: client.id,
        });
        expect(row.payload).toMatchObject({ count: 1, actor_role: 'client' });
      }
    });

    it('bulk of 3: exactly one row per other member with count 3; a repeat writes nothing', async () => {
      const assets = [
        await seedAsset(g, ws.id, owner.id),
        await seedAsset(g, ws.id, owner.id),
        await seedAsset(g, ws.id, owner.id),
      ];
      const ids = assets.map((a) => a.assetId);
      // The first delete by the agency in this workspace.
      expect((await deleteAssets(agency, ids)).error).toBeNull();
      const rows = (await inbox(ws.id, 'assets_deleted')).filter(
        (r) => r.actor_user_id === agency.id,
      );
      expect(rows.map((r) => r.user_id).sort()).toEqual([owner.id, client.id].sort());
      for (const row of rows) {
        expect(row.payload).toMatchObject({ count: 3, actor_role: 'agency' });
        expect((row.payload.filenames as unknown[]).length).toBeLessThanOrEqual(3);
      }
      const after = (await inbox(ws.id, 'assets_deleted')).length;
      // The ids are already deleted: refused (nothing live) and no new row.
      await deleteAssets(agency, ids);
      expect((await inbox(ws.id, 'assets_deleted')).length).toBe(after);
    });

    it('a member of another workspace gets nothing', async () => {
      const asset = await seedAsset(g, ws.id, owner.id);
      expect((await deleteAsset(agency, asset.assetId)).error).toBeNull();
      const p = await seedPost('review');
      expect((await deletePost(agency, p.id)).error).toBeNull();
      const res = await g.from('inbox_entries').select('id').eq('user_id', outsider.id);
      if (res.error) throw new Error(`inbox read failed: ${res.error.message}`);
      expect(res.data as unknown[]).toHaveLength(0);
      expect(await inbox(other.id, 'assets_deleted')).toHaveLength(0);
      expect(await inbox(other.id, 'post_deleted')).toHaveLength(0);
    });
  });
});

// post_soft_delete draft recipients (20261007120000_post_soft_delete_draft_recipients.sql):
// a deleted DRAFT notifies only roles with pipeline.view_all_stages (owner, admin,
// agency); a client gets nothing. A deleted REVIEW post still reaches the client.
describe.runIf(RLS_SUITE)('post_deleted recipients for a draft', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let adminUser: SeededUser;
  let agency: SeededUser;
  let agency2: SeededUser;
  let client: SeededUser;
  let ws: SeededWorkspace;
  let bucketId: string;

  async function seedPost(stage: string): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title: `Post ${randomSuffix()}`,
      bucket_id: bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage,
      created_by: owner.id,
    });
    return String(post.id);
  }

  async function recipients(postId: string): Promise<string[]> {
    const res = await g
      .from('inbox_entries')
      .select('user_id, entity_id, actor_user_id')
      .eq('workspace_id', ws.id)
      .eq('event_type', 'post_deleted');
    if (res.error) throw new Error(`inbox read failed: ${res.error.message}`);
    return (res.data as { user_id: string; entity_id: string; actor_user_id: string | null }[])
      .filter((row) => row.entity_id === postId && row.user_id !== row.actor_user_id)
      .map((row) => row.user_id)
      .sort();
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    adminUser = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    agency2 = await seedUser(env, admin);
    client = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Draft recipients ${owner.email}`);
    await seedMember(g, ws, adminUser, 'admin');
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, agency2, 'agency');
    await seedMember(g, ws, client, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, adminUser, agency, agency2, client]);
  });

  it('agency deletes a DRAFT: owner, admin and the other agency get post_deleted, the client none', async () => {
    const postId = await seedPost('draft');
    const res = await clientFor(agency.id).rpc(
      'post_soft_delete',
      rpcArgs({ p_post_id: postId, p_trace_id: uuidv7() }),
    );
    expect(res.error).toBeNull();
    expect(await recipients(postId)).toEqual([owner.id, adminUser.id, agency2.id].sort());
  });

  it('agency deletes a REVIEW post: the client gets one too', async () => {
    const postId = await seedPost('review');
    const res = await clientFor(agency.id).rpc(
      'post_soft_delete',
      rpcArgs({ p_post_id: postId, p_trace_id: uuidv7() }),
    );
    expect(res.error).toBeNull();
    const got = await recipients(postId);
    expect(got).toEqual([owner.id, adminUser.id, agency2.id, client.id].sort());
    expect(got.filter((id) => id === client.id)).toHaveLength(1);
  });
});
