// Activity: the actor's own row, brief activity for every member, and the
// new brief events (20261018140000_activity_brief_and_own_rows.sql), plus the
// owner-only audit_log_write lock (20261018130000_audit_log_write_owner_only.sql).
//
// - Every Activity-writing proc gives the person who acted exactly one row of
//   their own, already read (inbox_self_entry), even in a one-member workspace.
// - brief_close writes brief_closed to every other active member, client included,
//   naming the closer as actor.
// - brief_create and brief comments reach clients.
// - post_create from a brief writes brief_post_created only to members who can see drafts.
// - inbox_self_entry and audit_log_write are not callable by app users (forged audit row).
// - A member of another workspace gets nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  createAnonClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
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
  entity_id: string | null;
  read_at: string | null;
  payload: Record<string, unknown>;
}

interface RpcResult {
  data?: unknown;
  error: { message: string } | null;
}

/** Typed pass-through for direct .rpc() args; each proc takes its own p_trace_id. */
function rpcArgs<T>(args: T): T {
  return args;
}

/** Untyped rpc for calls that must fail (no generated signature to satisfy). */
async function rawRpc(
  client: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const untyped = client as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => PromiseLike<RpcResult>;
  };
  return await untyped.rpc(fn, args);
}

describe.runIf(RLS_SUITE)('activity: own rows and brief activity', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let solo: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let soloWs: SeededWorkspace;
  let other: SeededWorkspace;
  let bucketId: string;
  let soloBucketId: string;

  async function bucketFor(workspaceId: string): Promise<string> {
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: workspaceId,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    return String(bucket.id);
  }

  async function seedPost(
    workspaceId: string,
    bucket: string,
    ownerId: string,
    stage: string,
  ): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: workspaceId,
      number: await nextEntityNumber(g, workspaceId),
      title: `Post ${randomSuffix()}`,
      bucket_id: bucket,
      owner_user_id: ownerId,
      platform: 'linkedin',
      format: 'text',
      stage,
      created_by: ownerId,
    });
    return String(post.id);
  }

  /** Service-role ground truth: every row of one event for one entity. */
  async function rows(
    workspaceId: string,
    eventType: string,
    entityId: string,
  ): Promise<InboxRow[]> {
    const res = await g
      .from('inbox_entries')
      .select('user_id, actor_user_id, entity_id, read_at, payload')
      .eq('workspace_id', workspaceId)
      .eq('event_type', eventType)
      .eq('entity_id', entityId);
    if (res.error) throw new Error(`inbox read failed: ${res.error.message}`);
    return (res.data ?? []) as InboxRow[];
  }

  function own(list: InboxRow[], userId: string): InboxRow[] {
    return list.filter((r) => r.user_id === userId && r.actor_user_id === userId);
  }

  function others(list: InboxRow[]): string[] {
    return list
      .filter((r) => r.user_id !== r.actor_user_id)
      .map((r) => r.user_id)
      .sort();
  }

  async function createBrief(user: SeededUser, workspaceId: string): Promise<string> {
    const res = await clientFor(user.id).rpc(
      'brief_create',
      rpcArgs({
        p_workspace_id: workspaceId,
        p_payload: { title: `Brief ${randomSuffix()}`, objective: 'Launch the range' },
        p_trace_id: uuidv7(),
      }),
    );
    expect(res.error).toBeNull();
    return String(res.data);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    client2 = await seedUser(env, admin);
    solo = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Activity own ${owner.email}`);
    soloWs = await seedWorkspace(admin, solo, `Activity solo ${solo.email}`);
    other = await seedWorkspace(admin, outsider, `Activity other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    bucketId = await bucketFor(ws.id);
    soloBucketId = await bucketFor(soloWs.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [ws, soloWs, other],
      [owner, agency, client, client2, solo, outsider],
    );
  });

  it('stage_transition: the actor gets exactly one own row, already read', async () => {
    const postId = await seedPost(ws.id, bucketId, owner.id, 'review');
    const res = await clientFor(agency.id).rpc(
      'stage_transition',
      rpcArgs({ p_post_id: postId, p_to_stage: 'approved', p_trace_id: uuidv7() }),
    );
    expect(res.error).toBeNull();
    const list = await rows(ws.id, 'stage_change', postId);
    const mine = own(list, agency.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.read_at).not.toBeNull();
    expect(mine[0]?.payload).toMatchObject({
      from: 'review',
      to: 'approved',
      actor_role: 'agency',
    });
    expect(others(list)).toEqual([owner.id, client.id, client2.id].sort());
  });

  it('one-member workspace: the actor still gets an own row', async () => {
    const postId = await seedPost(soloWs.id, soloBucketId, solo.id, 'draft');
    const res = await clientFor(solo.id).rpc(
      'stage_transition',
      rpcArgs({ p_post_id: postId, p_to_stage: 'review', p_trace_id: uuidv7() }),
    );
    expect(res.error).toBeNull();
    const list = await rows(soloWs.id, 'stage_change', postId);
    expect(list).toHaveLength(1);
    expect(own(list, solo.id)).toHaveLength(1);
  });

  it('comment_create: the author gets one own row; every recipient exactly one row', async () => {
    const postId = await seedPost(ws.id, bucketId, owner.id, 'review');
    const res = await clientFor(owner.id).rpc(
      'comment_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'Tighten the hook',
        p_mentions: null,
        p_attachment_asset_ids: [],
        p_trace_id: uuidv7(),
      }),
    );
    expect(res.error).toBeNull();
    const list = await rows(ws.id, 'comment', postId);
    expect(own(list, owner.id)).toHaveLength(1);
    const recipients = others(list);
    expect(recipients).toEqual([agency.id, client.id, client2.id].sort());
    expect(new Set(recipients).size).toBe(recipients.length);
  });

  it('brief_create reaches every member incl. other clients; the creator gets an own row', async () => {
    const briefId = await createBrief(client, ws.id);
    const list = await rows(ws.id, 'brief_created', briefId);
    expect(others(list)).toEqual([owner.id, agency.id, client2.id].sort());
    expect(own(list, client.id)).toHaveLength(1);
    for (const row of list) expect(row.actor_user_id).toBe(client.id);
  });

  it('brief comments and mentions reach clients who did not create the brief', async () => {
    const briefId = await createBrief(client, ws.id);
    const res = await clientFor(agency.id).rpc(
      'comment_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_entity_type: 'brief',
        p_entity_id: briefId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'Need references',
        p_mentions: [client2.id],
        p_attachment_asset_ids: [],
        p_trace_id: uuidv7(),
      }),
    );
    expect(res.error).toBeNull();
    expect(others(await rows(ws.id, 'mention', briefId))).toEqual([client2.id]);
    expect(others(await rows(ws.id, 'comment', briefId))).toEqual([owner.id, client.id].sort());
  });

  it('brief_close: every other member, client included, sees who closed it', async () => {
    const briefId = await createBrief(client, ws.id);
    const res = await clientFor(owner.id).rpc(
      'brief_close',
      rpcArgs({ p_brief_id: briefId, p_trace_id: uuidv7() }),
    );
    expect(res.error).toBeNull();
    const list = await rows(ws.id, 'brief_closed', briefId);
    expect(others(list)).toEqual([agency.id, client.id, client2.id].sort());
    expect(own(list, owner.id)).toHaveLength(1);
    for (const row of list) {
      expect(row.actor_user_id).toBe(owner.id);
      expect(row.payload).toMatchObject({ actor_role: 'owner' });
    }
  });

  it('post_create from a brief: brief_post_created for draft viewers, not the client', async () => {
    const briefId = await createBrief(client, ws.id);
    const res = await clientFor(agency.id).rpc(
      'post_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_payload: {
          title: `From brief ${randomSuffix()}`,
          format: 'text',
          bucket_id: bucketId,
          origin: 'brief',
          brief_id: briefId,
        },
        p_trace_id: uuidv7(),
      }),
    );
    expect(res.error).toBeNull();
    const postId = String(res.data);
    const list = await rows(ws.id, 'brief_post_created', postId);
    expect(others(list)).toEqual([owner.id]);
    expect(own(list, agency.id)).toHaveLength(1);
    expect(list.some((r) => r.user_id === client.id || r.user_id === client2.id)).toBe(false);
    expect(list[0]?.payload).toMatchObject({ brief_id: briefId });
  });

  it('forged audit row: authenticated and anon cannot call audit_log_write or inbox_self_entry', async () => {
    const env = loadRlsEnv();
    const anon = createAnonClient(env);
    const audit = {
      p_action: 'stage_transition',
      p_outcome: 'success',
      p_trace_id: uuidv7(),
      p_workspace_id: other.id,
      p_entity_type: 'post',
      p_entity_id: uuidv7(),
      p_payload: { forged: true },
    };
    const self = {
      p_workspace_id: other.id,
      p_event_type: 'stage_change',
      p_entity_type: 'post',
      p_entity_id: uuidv7(),
      p_scope: 'posts',
      p_scope_key: null,
      p_payload: {},
    };
    for (const caller of [clientFor(owner.id), anon]) {
      expect((await rawRpc(caller, 'audit_log_write', audit)).error).not.toBeNull();
      expect((await rawRpc(caller, 'inbox_self_entry', self)).error).not.toBeNull();
    }
  });

  it('a member of another workspace gets nothing', async () => {
    const mine = await g.from('inbox_entries').select('event_type').eq('user_id', outsider.id);
    if (mine.error) throw new Error(`inbox read failed: ${mine.error.message}`);
    const mineRows = (mine.data ?? []) as { event_type: string }[];
    expect(mineRows.filter((r) => r.event_type !== 'system')).toHaveLength(0);
    const leak = await g.from('inbox_entries').select('event_type').eq('workspace_id', other.id);
    if (leak.error) throw new Error(`inbox read failed: ${leak.error.message}`);
    const leakRows = (leak.data ?? []) as { event_type: string }[];
    expect(leakRows.filter((r) => r.event_type !== 'system')).toHaveLength(0);
  });
});
