// Plan item days (20261012120000_plan_item_days.sql), exercised as the
// AUTHENTICATED role. The service-role admin client only seeds members and
// posts; plan state is read back as an agency member through RLS (the plan
// tables grant service_role no SELECT).
//
// Covered: plan_item_move by the agency inside the plan's dates sets the day
// and the order; outside is 'date_outside_plan'; null (No date) is ok; a
// client is forbidden_role; another workspace's agency is refused; a wrong
// item list is invalid_payload; a day change resets the team and client
// reviews to waiting; a same-day reorder keeps them. plan_posts_add with
// p_target_date sets that day; without it a post takes its own date when it is
// inside the plan and no date when outside; p_target_date outside the plan is
// 'date_outside_plan'. Concept and post items both carry target_date.
// No teardown: this suite runs no deletes; every fixture has its own workspace.

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
type ProcName =
  | 'plan_create'
  | 'plan_concept_add'
  | 'plan_posts_add'
  | 'plan_item_move'
  | 'plan_item_review';

interface Outcome<T> {
  data: T | null;
  error: { message: string } | null;
  traceId: string;
}

const STARTS = '2026-11-01';
const ENDS = '2026-11-30';

describe.runIf(RPC_SUITE)('plan item days (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let otherAgency: SeededUser;
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

  /** plan_item_move with a nullable day (the generated Args type says string). */
  function move(
    user: SeededUser,
    itemId: string,
    day: string | null,
    order: string[],
  ): Promise<Outcome<Rpc['plan_item_move']['Returns']>> {
    return call(user, 'plan_item_move', {
      p_item_id: itemId,
      p_target_date: day as string,
      p_item_ids: order,
    });
  }

  async function seedPost(targetDate: string | null): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title: `Post ${randomSuffix()}`,
      bucket_id: bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage: 'review',
      created_by: owner.id,
      target_date: targetDate,
    });
    return String(post.id);
  }

  async function newPlan(audience: 'team' | 'client' = 'client'): Promise<string> {
    return ok(
      'plan_create',
      await call(agency, 'plan_create', {
        p_workspace_id: ws.id,
        p_title: `Plan ${randomSuffix()}`,
        p_starts_on: STARTS,
        p_ends_on: ENDS,
        p_audience: audience,
      }),
    );
  }

  async function newConcept(planId: string, day: string | null = null): Promise<string> {
    return ok(
      'plan_concept_add',
      await call(agency, 'plan_concept_add', {
        p_plan_id: planId,
        p_title: `Concept ${randomSuffix()}`,
        p_description: 'A concept',
        p_attachment_version_ids: [],
        ...(day !== null ? { p_target_date: day } : {}),
      }),
    );
  }

  async function addPosts(planId: string, postIds: string[], day?: string): Promise<number> {
    return ok(
      'plan_posts_add',
      await call(agency, 'plan_posts_add', {
        p_plan_id: planId,
        p_post_ids: postIds,
        ...(day !== undefined ? { p_target_date: day } : {}),
      }),
    );
  }

  async function items(
    planId: string,
  ): Promise<
    Array<{ id: string; kind: string; post_id: string | null; target_date: string | null }>
  > {
    const res = await clientFor(agency.id)
      .from('plan_items')
      .select('id, kind, post_id, target_date, position')
      .eq('plan_id', planId)
      .order('position');
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    return res.data;
  }

  async function reviews(itemId: string): Promise<Array<{ side: string; status: string }>> {
    const res = await clientFor(agency.id)
      .from('plan_item_reviews')
      .select('side, status')
      .eq('item_id', itemId)
      .order('side');
    if (res.error !== null) throw new Error(`reviews read failed: ${res.error.message}`);
    return res.data;
  }

  async function reviewBoth(itemId: string): Promise<void> {
    ok(
      'plan_item_review',
      await call(agency, 'plan_item_review', {
        p_item_id: itemId,
        p_side: 'team',
        p_status: 'approved',
      }),
    );
    ok(
      'plan_item_review',
      await call(client, 'plan_item_review', {
        p_item_id: itemId,
        p_side: 'client',
        p_status: 'approved',
      }),
    );
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    otherAgency = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan days ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    const otherWs = await seedWorkspace(admin, owner, `Plan days other ${owner.email}`);
    await seedMember(g, otherWs, otherAgency, 'agency');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
  });

  it('plan_item_move: the agency moves inside the plan, sets the day and the order, audited', async () => {
    const planId = await newPlan();
    const a = await newConcept(planId, '2026-11-02');
    const b = await newConcept(planId, '2026-11-03');
    const moved = await move(agency, a, '2026-11-10', [b, a]);
    expect(moved.error).toBeNull();
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', moved.traceId],
        ['action', 'plan_item_move'],
      ]),
    ).toBe(1);
    const after = await items(planId);
    expect(after.map((i) => i.id)).toEqual([b, a]);
    expect(after.find((i) => i.id === a)?.target_date).toBe('2026-11-10');
  });

  it("plan_item_move: a day outside the plan is 'date_outside_plan'; null (No date) is ok", async () => {
    const planId = await newPlan();
    const a = await newConcept(planId, '2026-11-02');
    expect((await move(agency, a, '2026-12-01', [a])).error?.message).toBe('date_outside_plan');
    expect((await move(agency, a, '2026-10-31', [a])).error?.message).toBe('date_outside_plan');
    expect((await items(planId))[0]?.target_date).toBe('2026-11-02');
    expect((await move(agency, a, null, [a])).error).toBeNull();
    expect((await items(planId))[0]?.target_date).toBeNull();
  });

  it('plan_item_move: a client is forbidden_role; another workspace is refused', async () => {
    const planId = await newPlan();
    const a = await newConcept(planId, '2026-11-02');
    expect((await move(client, a, '2026-11-05', [a])).error?.message).toBe('forbidden_role');
    const other = await move(otherAgency, a, '2026-11-05', [a]);
    expect(['forbidden_role', 'invalid_payload']).toContain(other.error?.message);
    expect((await items(planId))[0]?.target_date).toBe('2026-11-02');
  });

  it('plan_item_move: a wrong item list is invalid_payload', async () => {
    const planId = await newPlan();
    const a = await newConcept(planId);
    const b = await newConcept(planId);
    const foreign = await newConcept(await newPlan());
    for (const order of [[a], [a, a], [a, b, b], [a, foreign]]) {
      expect((await move(agency, a, '2026-11-05', order)).error?.message).toBe('invalid_payload');
    }
  });

  it('plan_item_move: a day change resets team and client reviews to waiting', async () => {
    const planId = await newPlan();
    const a = await newConcept(planId, '2026-11-02');
    await reviewBoth(a);
    expect(await reviews(a)).toEqual([
      { side: 'client', status: 'approved' },
      { side: 'team', status: 'approved' },
    ]);
    expect((await move(agency, a, '2026-11-04', [a])).error).toBeNull();
    expect(await reviews(a)).toEqual([
      { side: 'client', status: 'waiting' },
      { side: 'team', status: 'waiting' },
    ]);
  });

  it('plan_item_move: a same-day reorder keeps the reviews', async () => {
    const planId = await newPlan();
    const a = await newConcept(planId, '2026-11-02');
    const b = await newConcept(planId, '2026-11-02');
    await reviewBoth(a);
    expect((await move(agency, a, '2026-11-02', [b, a])).error).toBeNull();
    expect((await items(planId)).map((i) => i.id)).toEqual([b, a]);
    expect(await reviews(a)).toEqual([
      { side: 'client', status: 'approved' },
      { side: 'team', status: 'approved' },
    ]);
  });

  it('plan_posts_add with p_target_date sets that day on every added post', async () => {
    const planId = await newPlan();
    const inside = await seedPost('2026-11-20T12:00:00Z');
    const none = await seedPost(null);
    expect(await addPosts(planId, [inside, none], '2026-11-07')).toBe(2);
    expect((await items(planId)).map((i) => i.target_date)).toEqual(['2026-11-07', '2026-11-07']);
  });

  it("without p_target_date: the post's own date inside the plan, else no date", async () => {
    const planId = await newPlan();
    const inside = await seedPost('2026-11-20T12:00:00Z');
    const outside = await seedPost('2026-12-20T12:00:00Z');
    const undated = await seedPost(null);
    expect(await addPosts(planId, [inside, outside, undated])).toBe(3);
    const byPost = new Map((await items(planId)).map((i) => [i.post_id, i.target_date]));
    expect(byPost.get(inside)).toBe('2026-11-20');
    expect(byPost.get(outside)).toBeNull();
    expect(byPost.get(undated)).toBeNull();
  });

  it("plan_posts_add: p_target_date outside the plan is 'date_outside_plan'", async () => {
    const planId = await newPlan();
    const post = await seedPost(null);
    const res = await call(agency, 'plan_posts_add', {
      p_plan_id: planId,
      p_post_ids: [post],
      p_target_date: '2026-12-01',
    });
    expect(res.error?.message).toBe('date_outside_plan');
    expect(await items(planId)).toEqual([]);
  });

  it('concept and post items both carry target_date (the concept-only constraint is gone)', async () => {
    const planId = await newPlan();
    const concept = await newConcept(planId, '2026-11-03');
    await addPosts(planId, [await seedPost(null)], '2026-11-04');
    const rows = await items(planId);
    expect(rows.find((i) => i.id === concept)?.target_date).toBe('2026-11-03');
    expect(rows.find((i) => i.kind === 'post')?.target_date).toBe('2026-11-04');
    // A post item moves like a concept.
    const post = rows.find((i) => i.kind === 'post');
    if (post === undefined) throw new Error('no post item');
    expect((await move(agency, post.id, '2026-11-09', [concept, post.id])).error).toBeNull();
    expect((await items(planId)).find((i) => i.id === post.id)?.target_date).toBe('2026-11-09');
  });
});
