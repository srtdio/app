// Slot approval on plan post items and the plan-aware post_deleted fan-out
// (20261012090000_plan_item_review_client_post_slots.sql,
// 20261012091000_post_soft_delete_notify_client_plans.sql), exercised as the
// AUTHENTICATED role. The service-role admin client only seeds members and
// posts and reads posts, audit_log and inbox_entries back; plans are built
// through the plan procs.
//
// Covered: a client approves a post slot on a client plan (posts.stage
// unchanged); a client on a team plan is forbidden_role; a draft post is
// post_not_ready; a soft-deleted post is invalid_payload; the agency's team
// tick on a post is ok; a client tick notifies the agency and the other
// clients, never the actor; approved -> waiting adds one withdrawal row
// (withdrawn true, previous approved) and keeps the approval row; waiting ->
// waiting adds nothing; a team-side withdrawal reaches agency roles only.
// post_soft_delete: a draft in a live client plan notifies clients; a draft in
// a team plan or no plan does not; a non-draft still reaches everyone.
// No teardown: this suite runs no DELETE; every fixture has its own workspace.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  countWhere,
  createAdminClient,
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

const RPC_SUITE = process.env.RPC_SUITE === '1';

type Rpc = Database['public']['Functions'];
type ProcName = 'plan_create' | 'plan_posts_add' | 'plan_item_review' | 'post_soft_delete';

interface Outcome<T> {
  data: T | null;
  error: { message: string } | null;
  traceId: string;
}

interface ReviewEntry {
  user_id: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
}

describe.runIf(RPC_SUITE)('plan slot approval (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let ws: SeededWorkspace;
  let bucketId: string;

  async function call<P extends ProcName>(
    user: SeededUser,
    proc: P,
    args: Omit<Rpc[P]['Args'], 'p_trace_id'>,
  ): Promise<Outcome<Rpc[P]['Returns']>> {
    const traceId = uuidv7();
    const full = { ...args, p_trace_id: traceId } as Rpc[P]['Args'];
    const res = await clientFor(user.id).rpc(proc, full);
    return {
      data: (res.data ?? null) as Rpc[P]['Returns'] | null,
      error: res.error === null ? null : { message: res.error.message },
      traceId,
    };
  }

  function ok<T>(proc: string, outcome: Outcome<T>): T {
    if (outcome.error !== null) throw new Error(`${proc} failed: ${outcome.error.message}`);
    return outcome.data as T;
  }

  function refusedWith<T>(outcome: Outcome<T>, message: string): void {
    expect(outcome.error?.message).toBe(message);
  }

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

  async function newPlan(audience: 'team' | 'client'): Promise<string> {
    return ok(
      'plan_create',
      await call(agency, 'plan_create', {
        p_workspace_id: ws.id,
        p_title: `Plan ${randomSuffix()}`,
        p_starts_on: '2026-11-01',
        p_ends_on: '2026-11-30',
        p_audience: audience,
      }),
    );
  }

  /** A post at `stage` in a fresh plan: the post id and its item id. */
  async function postItem(
    audience: 'team' | 'client',
    stage: string,
  ): Promise<{ planId: string; postId: string; itemId: string }> {
    const planId = await newPlan(audience);
    const postId = await seedPost(stage);
    ok(
      'plan_posts_add',
      await call(agency, 'plan_posts_add', { p_plan_id: planId, p_post_ids: [postId] }),
    );
    const res = await clientFor(agency.id)
      .from('plan_items')
      .select('id')
      .eq('plan_id', planId)
      .eq('post_id', postId)
      .single();
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    return { planId, postId, itemId: String(res.data.id) };
  }

  function review(
    user: SeededUser,
    itemId: string,
    side: 'team' | 'client',
    status: 'waiting' | 'approved' | 'changes',
  ): Promise<Outcome<Rpc['plan_item_review']['Returns']>> {
    return call(user, 'plan_item_review', {
      p_item_id: itemId,
      p_side: side,
      p_status: status,
    });
  }

  async function stageOf(postId: string): Promise<string> {
    const res = await admin.from('posts').select('stage').eq('id', postId).single();
    if (res.error !== null) throw new Error(`posts read failed: ${res.error.message}`);
    return res.data.stage;
  }

  async function entries(itemId: string): Promise<ReviewEntry[]> {
    const res = await admin
      .from('inbox_entries')
      .select('user_id, actor_user_id, payload')
      .eq('entity_id', itemId)
      .eq('event_type', 'plan_review');
    if (res.error !== null) throw new Error(`inbox_entries read failed: ${res.error.message}`);
    return res.data as unknown as ReviewEntry[];
  }

  const withdrawn = (rows: ReviewEntry[]): ReviewEntry[] =>
    rows.filter((r) => r.payload.withdrawn === true);
  const users = (rows: ReviewEntry[]): string[] => [...new Set(rows.map((r) => r.user_id))].sort();
  const ids = (...list: SeededUser[]): string[] => list.map((u) => u.id).sort();

  async function deletedRecipients(postId: string): Promise<string[]> {
    const res = await admin
      .from('inbox_entries')
      .select('user_id')
      .eq('entity_id', postId)
      .eq('event_type', 'post_deleted');
    if (res.error !== null) throw new Error(`inbox_entries read failed: ${res.error.message}`);
    return res.data.map((r) => r.user_id).sort();
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    client2 = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan slots ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
  });

  it('a client approves a post slot on a client plan; posts.stage is unchanged', async () => {
    const { postId, itemId } = await postItem('client', 'review');
    const outcome = await review(client, itemId, 'client', 'approved');
    expect(outcome.error).toBeNull();
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', outcome.traceId],
        ['action', 'plan_item_review'],
      ]),
    ).toBe(1);
    expect(await stageOf(postId)).toBe('review');
  });

  it('a client on a team plan is forbidden_role', async () => {
    const { itemId } = await postItem('team', 'review');
    refusedWith(await review(client, itemId, 'client', 'approved'), 'forbidden_role');
  });

  it('a draft post is post_not_ready for the client', async () => {
    const { postId, itemId } = await postItem('client', 'draft');
    refusedWith(await review(client, itemId, 'client', 'approved'), 'post_not_ready');
    expect(await stageOf(postId)).toBe('draft');
  });

  it('a soft-deleted post is invalid_payload on either side', async () => {
    const { postId, itemId } = await postItem('client', 'review');
    ok('post_soft_delete', await call(agency, 'post_soft_delete', { p_post_id: postId }));
    refusedWith(await review(client, itemId, 'client', 'approved'), 'invalid_payload');
    refusedWith(await review(agency, itemId, 'team', 'approved'), 'invalid_payload');
  });

  it("the agency's team tick on a post is ok and leaves posts.stage alone", async () => {
    const { postId, itemId } = await postItem('team', 'draft');
    expect((await review(agency, itemId, 'team', 'approved')).error).toBeNull();
    expect(await stageOf(postId)).toBe('draft');
  });

  it('a client tick notifies the agency and the other clients, never the actor', async () => {
    const { planId, itemId } = await postItem('client', 'review');
    expect((await review(client, itemId, 'client', 'approved')).error).toBeNull();
    const rows = await entries(itemId);
    expect(users(rows)).toEqual(ids(owner, agency, client2));
    for (const row of rows) {
      expect(row.actor_user_id).toBe(client.id);
      expect(row.payload).toMatchObject({ side: 'client', status: 'approved', plan_id: planId });
    }
  });

  it('approved -> waiting adds one withdrawal row per recipient and keeps the approval', async () => {
    const { planId, itemId } = await postItem('client', 'review');
    expect((await review(client, itemId, 'client', 'approved')).error).toBeNull();
    const before = await entries(itemId);
    expect((await review(client, itemId, 'client', 'waiting')).error).toBeNull();
    const after = await entries(itemId);
    expect(after).toHaveLength(before.length * 2);
    expect(after.filter((r) => r.payload.status === 'approved')).toHaveLength(before.length);
    const gone = withdrawn(after);
    expect(users(gone)).toEqual(ids(owner, agency, client2));
    expect(gone).toHaveLength(before.length);
    for (const row of gone) {
      expect(row.payload).toMatchObject({
        side: 'client',
        status: 'waiting',
        withdrawn: true,
        previous: 'approved',
        plan_id: planId,
      });
    }
  });

  it('waiting -> waiting adds nothing', async () => {
    const { itemId } = await postItem('client', 'review');
    expect((await review(client, itemId, 'client', 'waiting')).error).toBeNull();
    expect((await review(client, itemId, 'client', 'waiting')).error).toBeNull();
    expect(await entries(itemId)).toEqual([]);
  });

  it('a team-side withdrawal reaches agency roles only', async () => {
    const { itemId } = await postItem('client', 'review');
    expect((await review(agency, itemId, 'team', 'approved')).error).toBeNull();
    expect((await review(agency, itemId, 'team', 'waiting')).error).toBeNull();
    const gone = withdrawn(await entries(itemId));
    expect(users(gone)).toEqual(ids(owner));
    for (const row of gone) {
      expect(row.payload).toMatchObject({ side: 'team', previous: 'approved' });
    }
  });

  it('post_soft_delete: a draft in a live client plan notifies the clients', async () => {
    const { postId } = await postItem('client', 'draft');
    ok('post_soft_delete', await call(agency, 'post_soft_delete', { p_post_id: postId }));
    expect(await deletedRecipients(postId)).toEqual(ids(owner, client, client2));
  });

  it('post_soft_delete: a draft in a team plan, or in no plan, reaches no client', async () => {
    const inTeam = (await postItem('team', 'draft')).postId;
    ok('post_soft_delete', await call(agency, 'post_soft_delete', { p_post_id: inTeam }));
    expect(await deletedRecipients(inTeam)).toEqual(ids(owner));
    const loose = await seedPost('draft');
    ok('post_soft_delete', await call(agency, 'post_soft_delete', { p_post_id: loose }));
    expect(await deletedRecipients(loose)).toEqual(ids(owner));
  });

  it('post_soft_delete: a non-draft still reaches every other member', async () => {
    const { postId } = await postItem('team', 'review');
    ok('post_soft_delete', await call(agency, 'post_soft_delete', { p_post_id: postId }));
    expect(await deletedRecipients(postId)).toEqual(ids(owner, client, client2));
  });
});
