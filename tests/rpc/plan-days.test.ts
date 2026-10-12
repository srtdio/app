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
// p_target_date writes that day onto every added post; without it a post keeps
// its own date when it is inside the plan; p_target_date outside the plan is
// 'date_outside_plan'.
//
// One date per post (20261012161000_plan_one_date_per_post.sql) and part 2b
// (20261012190000_plan_part_2b.sql): a post slot's day is posts.target_date at
// 12:00 workspace zone; post slots carry no plan_items.target_date (the mirror
// is gone and plan_items_target_date_concept_only is back). Covered: the 5-arg
// move on a post slot writes the post date only; p_keep_reviews true keeps
// both sides' reviews, false resets them; a
// post date outside the plan week soft-deletes the slot; a cleared post date
// keeps the slot undated; concept add/edit outside the week and posts add with
// no day of a post dated outside the week are 'date_outside_plan'.
// Plan delete (20261012162000_plan_delete_open_rules.sql): an agency member who
// is not the creator or an owner/admin is forbidden_role; the creator succeeds.
// Post dates and soft-deleted slots are read with psql (RLS hides deleted rows).
// Plan updated alerts (20261012163000_plan_updated_alerts.sql) with the 2b
// _plan_notify: one psql session drives the triggers with direct SQL inside a
// transaction on an Open plan, reads the inbox rows it wrote and rolls back:
// slot_added, concept_changed, renamed, slot_removed, and a post leaving by
// date announced once (plan_date_changed only; the app.plan_day_sync flag is
// back to 'off'); every payload carries plan_title. On a Draft plan only
// plan_deleted is sent. The trigger functions have no EXECUTE for
// authenticated.
// No teardown: this suite runs no deletes; every fixture has its own workspace.

import { execFileSync } from 'node:child_process';
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
  | 'plan_concept_edit'
  | 'plan_delete'
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
  let agency2: SeededUser;
  let dbUrl: string;
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

  /** 5-arg plan_item_move (p_keep_reviews); a nullable day as above. */
  async function move5(
    user: SeededUser,
    itemId: string,
    day: string | null,
    order: string[],
    keepReviews: boolean,
  ): Promise<Outcome<null>> {
    const traceId = uuidv7();
    const args = {
      p_item_id: itemId,
      p_target_date: day as string,
      p_item_ids: order,
      p_keep_reviews: keepReviews,
      p_trace_id: traceId,
    };
    const res = await clientFor(user.id).rpc('plan_item_move', args);
    return {
      data: null,
      error: res.error === null ? null : { message: res.error.message },
      traceId,
    };
  }

  /** Runs SQL as postgres on the local stack; returns the trimmed -At output. */
  function psql(sql: string): string {
    return execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
      encoding: 'utf8',
    }).trim();
  }

  /** Runs statements in ONE psql session (quiet, -At); returns non-empty output lines. */
  function psqlSession(statements: string[]): string[] {
    const out = execFileSync(
      'psql',
      [dbUrl, '-q', '-v', 'ON_ERROR_STOP=1', '-At', ...statements.flatMap((sql) => ['-c', sql])],
      { encoding: 'utf8' },
    );
    return out.split('\n').filter((line) => line !== '');
  }

  /** posts.target_date as an ISO instant, or null. */
  function postDate(postId: string): string | null {
    const out = psql(
      `select coalesce(to_char(target_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') from public.posts where id = '${postId}'`,
    );
    return out === '' ? null : out;
  }

  /** plan_items day and deleted flag, read past RLS (which hides deleted rows). */
  function slot(itemId: string): { target_date: string | null; deleted: boolean } {
    const [day = '', deleted = ''] = psql(
      `select coalesce(target_date::text, ''), (deleted_at is not null)::text from public.plan_items where id = '${itemId}'`,
    ).split('|');
    return { target_date: day === '' ? null : day, deleted: deleted === 'true' };
  }

  async function postSlot(planId: string, postId: string): Promise<string> {
    const row = (await items(planId)).find((i) => i.post_id === postId);
    if (row === undefined) throw new Error('no post slot');
    return row.id;
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
    agency2 = await seedUser(env, admin);
    dbUrl = env.dbUrl;
    ws = await seedWorkspace(admin, owner, `Plan days ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, agency2, 'agency');
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

  it('plan_posts_add with p_target_date writes that day onto every added post (2b: not the slot)', async () => {
    const planId = await newPlan();
    const inside = await seedPost('2026-11-20T12:00:00Z');
    const none = await seedPost(null);
    expect(await addPosts(planId, [inside, none], '2026-11-07')).toBe(2);
    expect((await items(planId)).map((i) => i.target_date)).toEqual([null, null]);
    expect(postDate(inside)).toBe('2026-11-07T12:00:00Z');
    expect(postDate(none)).toBe('2026-11-07T12:00:00Z');
  });

  it('without p_target_date: the post keeps its own date; the slot carries none', async () => {
    const planId = await newPlan();
    const inside = await seedPost('2026-11-20T12:00:00Z');
    const undated = await seedPost(null);
    expect(await addPosts(planId, [inside, undated])).toBe(2);
    expect((await items(planId)).every((i) => i.target_date === null)).toBe(true);
    expect(postDate(inside)).toBe('2026-11-20T12:00:00Z');
    expect(postDate(undated)).toBeNull();
  });

  it("without p_target_date: a post dated outside the plan week is 'date_outside_plan'", async () => {
    const planId = await newPlan();
    const outside = await seedPost('2026-12-20T12:00:00Z');
    const undated = await seedPost(null);
    const res = await call(agency, 'plan_posts_add', {
      p_plan_id: planId,
      p_post_ids: [undated, outside],
    });
    expect(res.error?.message).toBe('date_outside_plan');
    expect(await items(planId)).toEqual([]);
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

  it('only concepts carry target_date (plan_items_target_date_concept_only, 2b)', async () => {
    const planId = await newPlan();
    const concept = await newConcept(planId, '2026-11-03');
    const postId = await seedPost(null);
    await addPosts(planId, [postId], '2026-11-04');
    const rows = await items(planId);
    expect(rows.find((i) => i.id === concept)?.target_date).toBe('2026-11-03');
    expect(rows.find((i) => i.kind === 'post')?.target_date).toBeNull();
    // A post item moves by its post's date, never plan_items.target_date.
    const post = rows.find((i) => i.kind === 'post');
    if (post === undefined) throw new Error('no post item');
    expect((await move(agency, post.id, '2026-11-09', [concept, post.id])).error).toBeNull();
    expect((await items(planId)).find((i) => i.id === post.id)?.target_date).toBeNull();
    expect(postDate(postId)).toBe('2026-11-09T12:00:00Z');
    // The CHECK refuses a day on a post slot.
    expect(() =>
      psql(`update public.plan_items set target_date = '2026-11-05' where id = '${post.id}'`),
    ).toThrow(/plan_items_target_date_concept_only/);
  });

  it('5-arg move on a post slot writes posts.target_date at 12:00 workspace zone; no mirror (2b)', async () => {
    psql(
      `update public.workspaces set timezone = 'Asia/Kolkata', row_version = row_version + 1 where id = '${ws.id}'`,
    );
    try {
      const planId = await newPlan();
      const post = await seedPost(null);
      await addPosts(planId, [post]);
      const item = await postSlot(planId, post);
      expect(slot(item).target_date).toBeNull();
      expect((await move5(agency, item, '2026-11-10', [item], true)).error).toBeNull();
      // 12:00 in Asia/Kolkata (+05:30) is 06:30 UTC.
      expect(postDate(post)).toBe('2026-11-10T06:30:00Z');
      expect(slot(item)).toEqual({ target_date: null, deleted: false });
    } finally {
      psql(
        `update public.workspaces set timezone = 'UTC', row_version = row_version + 1 where id = '${ws.id}'`,
      );
    }
  });

  it('5-arg move: p_keep_reviews true keeps both sides, false resets them to waiting', async () => {
    const planId = await newPlan('client');
    const post = await seedPost('2026-11-02T12:00:00Z');
    await addPosts(planId, [post]);
    const item = await postSlot(planId, post);
    await reviewBoth(item);
    const approved = [
      { side: 'client', status: 'approved' },
      { side: 'team', status: 'approved' },
    ];
    expect((await move5(agency, item, '2026-11-05', [item], true)).error).toBeNull();
    expect(postDate(post)).toBe('2026-11-05T12:00:00Z');
    expect(await reviews(item)).toEqual(approved);
    expect((await move5(agency, item, '2026-11-06', [item], false)).error).toBeNull();
    expect(await reviews(item)).toEqual([
      { side: 'client', status: 'waiting' },
      { side: 'team', status: 'waiting' },
    ]);
  });

  it('a posts.target_date change outside the plan week soft-deletes the slot', async () => {
    const planId = await newPlan();
    const post = await seedPost('2026-11-02T12:00:00Z');
    await addPosts(planId, [post]);
    const item = await postSlot(planId, post);
    psql(
      `update public.posts set target_date = '2026-12-15T12:00:00Z', row_version = row_version + 1 where id = '${post}'`,
    );
    expect(slot(item).deleted).toBe(true);
    expect(await items(planId)).toEqual([]);
    expect(postDate(post)).toBe('2026-12-15T12:00:00Z');
  });

  it('a cleared post date keeps the slot, undated', async () => {
    const planId = await newPlan();
    const post = await seedPost('2026-11-02T12:00:00Z');
    await addPosts(planId, [post]);
    const item = await postSlot(planId, post);
    expect(slot(item)).toEqual({ target_date: null, deleted: false });
    psql(
      `update public.posts set target_date = null, row_version = row_version + 1 where id = '${post}'`,
    );
    expect(slot(item)).toEqual({ target_date: null, deleted: false });
    expect(postDate(post)).toBeNull();
  });

  it("concept add and edit outside the plan week are 'date_outside_plan'", async () => {
    const planId = await newPlan();
    const added = await call(agency, 'plan_concept_add', {
      p_plan_id: planId,
      p_title: 'Out of week',
      p_description: '',
      p_attachment_version_ids: [],
      p_target_date: '2026-12-02',
    });
    expect(added.error?.message).toBe('date_outside_plan');
    expect(await items(planId)).toEqual([]);
    const concept = await newConcept(planId, '2026-11-02');
    const edited = await call(agency, 'plan_concept_edit', {
      p_item_id: concept,
      p_title: 'Moved out',
      p_description: '',
      p_attachment_version_ids: [],
      p_target_date: '2026-10-31',
    });
    expect(edited.error?.message).toBe('date_outside_plan');
    expect(slot(concept).target_date).toBe('2026-11-02');
  });

  it('plan_delete: an agency member who is not the creator or owner/admin is forbidden_role; the creator succeeds', async () => {
    const planId = await newPlan();
    expect((await call(agency2, 'plan_delete', { p_plan_id: planId })).error?.message).toBe(
      'forbidden_role',
    );
    expect(psql(`select (deleted_at is null)::text from public.plans where id = '${planId}'`)).toBe(
      'true',
    );
    const deleted = await call(agency, 'plan_delete', { p_plan_id: planId });
    expect(deleted.error).toBeNull();
    expect(
      psql(`select (deleted_at is not null)::text from public.plans where id = '${planId}'`),
    ).toBe('true');
  });

  it('plan_updated alerts: triggers fire with the right kinds; a post leaving by date is announced once', async () => {
    const planId = await newPlan();
    const concept = await newConcept(planId, '2026-11-02');
    const post = await seedPost('2026-11-03T12:00:00Z');
    await addPosts(planId, [post]);
    const postItem = await postSlot(planId, post);
    const before = psql(
      `select count(*) from public.inbox_entries where entity_type = 'plan' and entity_id = '${planId}'`,
    );
    const lines = psqlSession([
      'begin',
      `insert into public.plan_items (workspace_id, plan_id, kind, position, title)
         select workspace_id, id, 'concept', 99, 'Tx concept' from public.plans where id = '${planId}'`,
      `update public.plan_items set title = 'Renamed concept' where id = '${concept}'`,
      `update public.plans set title = 'Renamed plan', updated_at = now() where id = '${planId}'`,
      `update public.posts set target_date = '2026-12-15T12:00:00Z', row_version = row_version + 1 where id = '${post}'`,
      `update public.plan_items set deleted_at = now() where plan_id = '${planId}' and title = 'Tx concept'`,
      `select 'flag:' || coalesce(current_setting('app.plan_day_sync', true), '')`,
      `select distinct 'event:' || e.event_type || ':' || coalesce(e.payload->>'kind', '') || ':' ||
              case when e.payload->>'item_id' = '${postItem}' then 'post'
                   when e.payload->>'item_id' = '${concept}' then 'concept'
                   when e.payload ? 'item_id' then 'new'
                   else '' end
         from public.inbox_entries e
        where e.entity_type = 'plan' and e.entity_id = '${planId}' and e.created_at >= now()
        order by 1`,
      `select 'titled:' || bool_and(e.payload->>'plan_title' is not null)::text
         from public.inbox_entries e
        where e.entity_type = 'plan' and e.entity_id = '${planId}' and e.created_at >= now()`,
      'rollback',
    ]);
    expect(lines).toContain('titled:true');
    expect(lines).toContain('flag:off');
    expect(lines.filter((l) => l.startsWith('event:'))).toEqual(
      [
        'event:plan_date_changed::post',
        'event:plan_updated:concept_changed:concept',
        'event:plan_updated:renamed:',
        'event:plan_updated:slot_added:new',
        'event:plan_updated:slot_removed:new',
      ].sort(),
    );
    // Rolled back: nothing from the transaction is left behind.
    expect(
      psql(
        `select count(*) from public.inbox_entries where entity_type = 'plan' and entity_id = '${planId}'`,
      ),
    ).toBe(before);
    expect(
      psql(
        `select string_agg(tgname, ',' order by tgname) from pg_trigger where tgname in ('plan_items_change_notify', 'plans_rename_notify')`,
      ),
    ).toBe('plan_items_change_notify,plans_rename_notify');
    expect(
      psql(
        `select bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('_plan_items_change_notify', '_plans_rename_notify', '_posts_plan_day_sync', '_plan_notify')`,
      ),
    ).toBe('false');
  });

  it('2b: a Draft plan sends no alerts except plan_deleted; payloads carry plan_title', async () => {
    const planId = await newPlan('team');
    const concept = await newConcept(planId, '2026-11-02');
    await addPosts(planId, [await seedPost('2026-11-03T12:00:00Z')]);
    psql(`update public.plan_items set title = 'Draft concept renamed' where id = '${concept}'`);
    const count = (): string =>
      psql(
        `select count(*) from public.inbox_entries where entity_type = 'plan' and entity_id = '${planId}'`,
      );
    expect(count()).toBe('0');
    expect((await call(agency, 'plan_delete', { p_plan_id: planId })).error).toBeNull();
    expect(
      psql(
        `select string_agg(distinct event_type || ':' || (payload->>'plan_title' is not null)::text, ',')
           from public.inbox_entries where entity_type = 'plan' and entity_id = '${planId}'`,
      ),
    ).toBe('plan_deleted:true');
  });
});
