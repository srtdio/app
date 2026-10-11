// Plans RLS (20261009110000_plans_core.sql). plans_select_member: active
// member, not deleted; a team plan only for owner/admin/agency. plan_items:
// readable when its plan is, and a post item only when its post is (so a draft
// stays hidden from a client through posts_select_member, even once the plan
// turns client-visible). plan_item_reviews: team reviews only for the agency
// side; client reviews for everyone who can read the item. An inactive member
// and another workspace's client see nothing. Authenticated has SELECT only:
// INSERT, UPDATE and DELETE are refused at the grant (permission denied).
// plan_draft_items (20261011011500_plan_drafts_in_client_plans) lists a plan's
// draft post rows (number, title, date) to whoever can read the plan, so a
// client sees a draft row in a client plan without posts SELECT on the draft.
//
// The tables grant service_role no SELECT/INSERT (live parity), so fixtures go
// through the procs as an agency member; the one direct change (a team plan
// turned client-visible with a draft still inside) runs as postgres via psql
// against the local container.

import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  createAdminClient,
  createAnonClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  ownReadCount,
  randomSuffix,
  partitionTimestamp,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  visibleRowCount,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/**
 * Typed pass-through for direct .rpc() args. Each write proc here takes its
 * own p_trace_id (a uuid v7, set at every call site); the read-only
 * plan_draft_items takes none. callRpc() is the app wrapper
 * and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

/** Unwrap an rpc result or throw with the proc name and message. */
function must<T>(proc: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error !== null || res.data === null) {
    throw new Error(`${proc} failed: ${res.error?.message ?? 'no data'}`);
  }
  return res.data;
}

describe.runIf(RLS_SUITE)('plans RLS', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let dbUrl: string;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let inactive: SeededUser;
  let outsider: SeededUser;
  let outsiderClient: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let bucketId: string;
  let draftPostId: string;
  let reviewPostId: string;
  let teamPlanId: string;
  let clientPlanId: string;
  let teamConceptId: string;
  let teamDraftItemId: string;
  let clientConceptId: string;
  let clientPostItemId: string;

  function as(user: SeededUser): SupabaseClient<Database> {
    return clientFor(user.id);
  }

  function read(user: SeededUser, table: string, id: string, key = 'id'): Promise<number> {
    return visibleRowCount(asGeneric(as(user)), table, [[key, id]]);
  }

  function own(user: SeededUser, table: string, id: string, key = 'id'): Promise<number> {
    return ownReadCount(asGeneric(as(user)), table, [[key, id]]);
  }

  async function seedPost(
    stage: string,
    bucketId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
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
      ...extra,
    });
    return String(post.id);
  }

  async function createPlan(audience: 'team' | 'client'): Promise<string> {
    return must(
      'plan_create',
      await as(agency).rpc(
        'plan_create',
        rpcArgs({
          p_workspace_id: ws.id,
          p_title: `Plan ${randomSuffix()}`,
          p_starts_on: '2026-11-01',
          p_ends_on: '2026-11-30',
          p_audience: audience,
          p_trace_id: uuidv7(),
        }),
      ),
    );
  }

  async function addConcept(planId: string): Promise<string> {
    return must(
      'plan_concept_add',
      await as(agency).rpc(
        'plan_concept_add',
        rpcArgs({
          p_plan_id: planId,
          p_title: 'Concept',
          p_description: 'A concept',
          p_attachment_version_ids: [],
          p_trace_id: uuidv7(),
        }),
      ),
    );
  }

  async function addPost(planId: string, postId: string): Promise<void> {
    must(
      'plan_posts_add',
      await as(agency).rpc(
        'plan_posts_add',
        rpcArgs({ p_plan_id: planId, p_post_ids: [postId], p_trace_id: uuidv7() }),
      ),
    );
  }

  async function postItemId(planId: string, postId: string): Promise<string> {
    const res = await as(agency)
      .from('plan_items')
      .select('id')
      .eq('plan_id', planId)
      .eq('post_id', postId);
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    const id = res.data[0]?.id;
    if (id === undefined) throw new Error('post item not found');
    return id;
  }

  async function review(
    user: SeededUser,
    itemId: string,
    side: 'team' | 'client',
    status: 'waiting' | 'approved' | 'changes',
  ): Promise<void> {
    const res = await as(user).rpc(
      'plan_item_review',
      rpcArgs({ p_item_id: itemId, p_side: side, p_status: status, p_trace_id: uuidv7() }),
    );
    if (res.error !== null) throw new Error(`plan_item_review failed: ${res.error.message}`);
  }

  /** Run one statement as postgres against the local container (fixture-only). */
  function asPostgres(sql: string): void {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
      encoding: 'utf8',
    });
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    dbUrl = env.dbUrl;
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    inactive = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    outsiderClient = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plans ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Plans other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, other, outsiderClient, 'client');
    // Inactive agency member: would see team plans if active.
    await insertRow(g, 'workspace_members', {
      workspace_id: ws.id,
      user_id: inactive.id,
      role: 'agency',
      active: false,
    });
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
    draftPostId = await seedPost('draft', bucketId);
    reviewPostId = await seedPost('review', bucketId);

    teamPlanId = await createPlan('team');
    teamConceptId = await addConcept(teamPlanId);
    await addPost(teamPlanId, draftPostId);
    teamDraftItemId = await postItemId(teamPlanId, draftPostId);

    clientPlanId = await createPlan('client');
    clientConceptId = await addConcept(clientPlanId);
    await addPost(clientPlanId, reviewPostId);
    clientPostItemId = await postItemId(clientPlanId, reviewPostId);
    await review(agency, clientConceptId, 'team', 'approved');
    await review(client, clientConceptId, 'client', 'changes');
  });

  // No teardown: this PR runs no DELETE anywhere; the container is ephemeral and
  // every fixture is scoped to its own fresh workspace and users.

  it('a team plan is invisible to the client and visible to agency and owner', async () => {
    expect(await read(client, 'plans', teamPlanId)).toBe(0);
    expect(await own(agency, 'plans', teamPlanId)).toBe(1);
    expect(await own(owner, 'plans', teamPlanId)).toBe(1);
    expect(await read(client, 'plan_items', teamConceptId)).toBe(0);
    expect(await own(agency, 'plan_items', teamConceptId)).toBe(1);
  });

  it('a client plan and its items are visible to both sides', async () => {
    expect(await own(client, 'plans', clientPlanId)).toBe(1);
    expect(await own(agency, 'plans', clientPlanId)).toBe(1);
    for (const user of [client, agency]) {
      expect(await own(user, 'plan_items', clientConceptId)).toBe(1);
      expect(await own(user, 'plan_items', clientPostItemId)).toBe(1);
    }
  });

  it('team reviews are invisible to the client; client reviews are visible to both', async () => {
    const team = (user: SeededUser) =>
      visibleRowCount(asGeneric(as(user)), 'plan_item_reviews', [
        ['item_id', clientConceptId],
        ['side', 'team'],
      ]);
    const clientSide = (user: SeededUser) =>
      ownReadCount(asGeneric(as(user)), 'plan_item_reviews', [
        ['item_id', clientConceptId],
        ['side', 'client'],
      ]);
    expect(await team(client)).toBe(0);
    expect(await team(agency)).toBe(1);
    expect(await clientSide(client)).toBe(1);
    expect(await clientSide(agency)).toBe(1);
  });

  it('an inactive member and another workspace client see nothing', async () => {
    for (const user of [inactive, outsiderClient]) {
      expect(await read(user, 'plans', teamPlanId)).toBe(0);
      expect(await read(user, 'plans', clientPlanId)).toBe(0);
      expect(await read(user, 'plan_items', clientConceptId)).toBe(0);
      expect(await read(user, 'plan_items', clientPostItemId)).toBe(0);
      expect(await read(user, 'plan_item_reviews', clientConceptId, 'item_id')).toBe(0);
    }
  });

  it('authenticated has no INSERT, UPDATE or DELETE on the plan tables (permission denied)', async () => {
    const c = as(agency);
    const denied = (error: { code?: string; message: string } | null): boolean =>
      error !== null && (error.code === '42501' || /permission denied/i.test(error.message));
    const inserts = await Promise.all([
      c.from('plans').insert({
        workspace_id: ws.id,
        title: 'x',
        starts_on: '2026-11-01',
        ends_on: '2026-11-02',
        audience: 'team',
      }),
      c.from('plan_items').insert({
        workspace_id: ws.id,
        plan_id: clientPlanId,
        kind: 'concept',
        title: 'x',
      }),
      c.from('plan_item_reviews').insert({
        item_id: clientConceptId,
        workspace_id: ws.id,
        side: 'team',
        status: 'approved',
      }),
    ]);
    for (const res of inserts) expect(denied(res.error)).toBe(true);
    const updates = await Promise.all([
      c.from('plans').update({ title: 'renamed' }).eq('id', clientPlanId),
      c.from('plan_items').update({ position: 9 }).eq('id', clientConceptId),
      c.from('plan_item_reviews').update({ status: 'waiting' }).eq('item_id', clientConceptId),
    ]);
    for (const res of updates) expect(denied(res.error)).toBe(true);
    const deletes = await Promise.all([
      c.from('plans').delete().eq('id', clientPlanId),
      c.from('plan_items').delete().eq('id', clientConceptId),
      c.from('plan_item_reviews').delete().eq('item_id', clientConceptId),
    ]);
    for (const res of deletes) expect(denied(res.error)).toBe(true);
    // Nothing changed.
    expect(await own(agency, 'plans', clientPlanId)).toBe(1);
    expect(await own(agency, 'plan_items', clientConceptId)).toBe(1);
  });

  async function comment(
    user: SeededUser,
    itemId: string,
    visibility: 'everyone' | 'team',
  ): Promise<string> {
    return must(
      'plan_item_comment_create',
      await as(user).rpc(
        'plan_item_comment_create',
        rpcArgs({
          p_item_id: itemId,
          p_body: `Comment ${randomSuffix()}`,
          p_visibility: visibility,
          p_trace_id: uuidv7(),
        }),
      ),
    );
  }

  it("a 'team' plan item comment is invisible to the client and visible to agency", async () => {
    const commentId = await comment(agency, clientConceptId, 'team');
    expect(await read(client, 'plan_item_comments', commentId)).toBe(0);
    expect(await own(agency, 'plan_item_comments', commentId)).toBe(1);
    expect(await own(owner, 'plan_item_comments', commentId)).toBe(1);
  });

  it("an 'everyone' comment on a client plan is visible to both sides", async () => {
    const fromAgency = await comment(agency, clientConceptId, 'everyone');
    const fromClient = await comment(client, clientPostItemId, 'everyone');
    for (const user of [client, agency]) {
      expect(await own(user, 'plan_item_comments', fromAgency)).toBe(1);
      expect(await own(user, 'plan_item_comments', fromClient)).toBe(1);
    }
    expect(await read(outsiderClient, 'plan_item_comments', fromAgency)).toBe(0);
  });

  it('authenticated has no INSERT, UPDATE or DELETE on plan_item_comments (permission denied)', async () => {
    const commentId = await comment(agency, clientConceptId, 'everyone');
    const c = as(agency);
    const denied = (error: { code?: string; message: string } | null): boolean =>
      error !== null && (error.code === '42501' || /permission denied/i.test(error.message));
    const insert = await c.from('plan_item_comments').insert({
      workspace_id: ws.id,
      item_id: clientConceptId,
      author_user_id: agency.id,
      body: 'x',
      visibility: 'everyone',
    });
    expect(denied(insert.error)).toBe(true);
    const update = await c
      .from('plan_item_comments')
      .update({ body: 'edited' })
      .eq('id', commentId);
    expect(denied(update.error)).toBe(true);
    const del = await c.from('plan_item_comments').delete().eq('id', commentId);
    expect(denied(del.error)).toBe(true);
    // Nothing changed.
    expect(await own(agency, 'plan_item_comments', commentId)).toBe(1);
  });

  it('a client in the chat reads a plan-share message row, but a team plan id on it is not readable', async () => {
    // A team plan cannot be shared into a chat with a client (chat_plan_share
    // refuses it), so the row is seeded through the service role to prove the
    // plans read stays gated even when an id leaks into a message.
    const hiddenTeamPlanId = await createPlan('team');
    const channelId = await seedDmChannel(g, ws.id, agency, client);
    const messageId = uuidv7();
    await insertRow(g, 'chat_messages', {
      id: messageId,
      channel_id: channelId,
      workspace_id: ws.id,
      sender_user_id: agency.id,
      body: 'Plans',
      shared_plan_ids: [hiddenTeamPlanId, clientPlanId],
      agora_event_id: null,
      created_at: partitionTimestamp,
    });
    expect(await own(client, 'chat_messages', messageId)).toBe(1);
    expect(await read(client, 'plans', hiddenTeamPlanId)).toBe(0);
    expect(await own(client, 'plans', clientPlanId)).toBe(1);
    expect(await own(agency, 'plans', hiddenTeamPlanId)).toBe(1);
  });

  async function conceptDate(itemId: string): Promise<string | null> {
    const res = await as(agency).from('plan_items').select('target_date').eq('id', itemId);
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    const row = res.data[0];
    if (row === undefined) throw new Error('concept not found');
    return row.target_date;
  }

  async function editConcept(itemId: string, targetDate?: string | null): Promise<void> {
    const res = await as(agency).rpc(
      'plan_concept_edit',
      rpcArgs({
        p_item_id: itemId,
        p_title: 'Concept',
        p_description: 'A concept',
        p_attachment_version_ids: [],
        p_trace_id: uuidv7(),
        ...(targetDate === undefined ? {} : { p_target_date: targetDate as string }),
      }),
    );
    if (res.error !== null) throw new Error(`plan_concept_edit failed: ${res.error.message}`);
  }

  /** Run one statement as postgres and return its error text ('' when it succeeds). */
  function postgresError(sql: string): string {
    try {
      asPostgres(sql);
      return '';
    } catch (err: unknown) {
      const stderr = (err as { stderr?: unknown }).stderr;
      return typeof stderr === 'string' ? stderr : String(err);
    }
  }

  // 20261010120000_plan_items_concept_date.sql: concepts carry an optional
  // target_date; post items never do (plan_items_target_date_concept_only).
  it('plan_concept_add with a date stores it; without one stores null', async () => {
    const dated = must(
      'plan_concept_add',
      await as(agency).rpc(
        'plan_concept_add',
        rpcArgs({
          p_plan_id: clientPlanId,
          p_title: 'Dated concept',
          p_description: 'A concept',
          p_attachment_version_ids: [],
          p_trace_id: uuidv7(),
          p_target_date: '2026-11-12',
        }),
      ),
    );
    expect(await conceptDate(dated)).toBe('2026-11-12');
    const undated = await addConcept(clientPlanId);
    expect(await conceptDate(undated)).toBeNull();
  });

  it('plan_concept_edit sets, changes and clears the date', async () => {
    const itemId = await addConcept(clientPlanId);
    await editConcept(itemId, '2026-11-03');
    expect(await conceptDate(itemId)).toBe('2026-11-03');
    await editConcept(itemId, '2026-11-20');
    expect(await conceptDate(itemId)).toBe('2026-11-20');
    await editConcept(itemId, null);
    expect(await conceptDate(itemId)).toBeNull();
  });

  it('a date-only concept edit resets an approved team review to waiting', async () => {
    const itemId = await addConcept(clientPlanId);
    await review(agency, itemId, 'team', 'approved');
    const status = async (): Promise<string | undefined> => {
      const res = await as(agency)
        .from('plan_item_reviews')
        .select('status')
        .eq('item_id', itemId)
        .eq('side', 'team');
      if (res.error !== null)
        throw new Error(`plan_item_reviews read failed: ${res.error.message}`);
      return res.data[0]?.status;
    };
    expect(await status()).toBe('approved');
    await editConcept(itemId, '2026-11-15');
    expect(await status()).toBe('waiting');
  });

  it('a post item with a target_date is refused by plan_items_target_date_concept_only', async () => {
    const insertErr = postgresError(
      `insert into public.plan_items (workspace_id, plan_id, kind, post_id, target_date) values ('${ws.id}', '${clientPlanId}', 'post', '${draftPostId}', '2026-11-05')`,
    );
    expect(insertErr).toMatch(/plan_items_target_date_concept_only/);
    const updateErr = postgresError(
      `update public.plan_items set target_date = '2026-11-05' where id = '${clientPostItemId}'`,
    );
    expect(updateErr).toMatch(/plan_items_target_date_concept_only/);
    const res = await as(agency)
      .from('plan_items')
      .select('target_date')
      .eq('id', clientPostItemId);
    expect(res.error).toBeNull();
    expect(res.data?.[0]?.target_date).toBeNull();
  });

  it('a client member calling plan_concept_add with a date is refused (forbidden_role)', async () => {
    const res = await as(client).rpc(
      'plan_concept_add',
      rpcArgs({
        p_plan_id: clientPlanId,
        p_title: 'Client concept',
        p_description: 'A concept',
        p_attachment_version_ids: [],
        p_trace_id: uuidv7(),
        p_target_date: '2026-11-10',
      }),
    );
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/forbidden_role/);
  });

  it('named-arg calls without p_target_date still work for add and edit', async () => {
    const itemId = await addConcept(clientPlanId);
    await editConcept(itemId);
    expect(await conceptDate(itemId)).toBeNull();
  });

  async function draftItems(user: SeededUser, planId: string) {
    const res = await as(user).rpc('plan_draft_items', rpcArgs({ p_plan_id: planId }));
    if (res.error !== null) throw new Error(`plan_draft_items failed: ${res.error.message}`);
    return res.data;
  }

  it('plan_draft_items: agency sees the team plan draft row; the client gets none', async () => {
    const rows = await draftItems(agency, teamPlanId);
    expect(rows.map((r) => r.item_id)).toEqual([teamDraftItemId]);
    expect(await draftItems(client, teamPlanId)).toHaveLength(0);
  });

  it('plan_draft_items: a client gets the draft row in a client plan while posts stays hidden', async () => {
    const targetDate = '2026-11-18T09:30:00+00:00';
    const datedDraftId = await seedPost('draft', bucketId, { target_date: targetDate });
    await addPost(clientPlanId, datedDraftId);
    const itemId = await postItemId(clientPlanId, datedDraftId);
    const post = await admin.from('posts').select('number, title').eq('id', datedDraftId).single();
    if (post.error !== null) throw new Error(`posts read failed: ${post.error.message}`);

    const rows = await draftItems(client, clientPlanId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.item_id).toBe(itemId);
    expect(row?.post_number).toBe(post.data.number);
    expect(row?.title).toBe(post.data.title);
    expect(new Date(row?.target_date ?? '').toISOString()).toBe(new Date(targetDate).toISOString());
    // The review post in the same plan is not a draft, so it is not listed.
    expect(rows.map((r) => r.item_id)).not.toContain(clientPostItemId);
    // The post itself stays hidden from the client.
    expect(await read(client, 'posts', datedDraftId)).toBe(0);
  });

  it('plan_draft_items: an inactive member and another workspace member get none', async () => {
    for (const user of [inactive, outsider, outsiderClient]) {
      expect(await draftItems(user, teamPlanId)).toHaveLength(0);
      expect(await draftItems(user, clientPlanId)).toHaveLength(0);
    }
  });

  it('plan_draft_items: anon cannot execute it', async () => {
    const anon = createAnonClient(loadRlsEnv());
    const res = await anon.rpc('plan_draft_items', rpcArgs({ p_plan_id: clientPlanId }));
    expect(res.error).not.toBeNull();
    expect(res.data).toBeNull();
  });

  // Runs last: it turns the team plan client-visible with its draft still inside.
  it('a draft post in a team plan stays hidden from the client once the plan turns client-visible', async () => {
    expect(await read(client, 'plan_items', teamDraftItemId)).toBe(0);
    asPostgres(
      `update public.plans set audience = 'client', shared_with_client_at = now() where id = '${teamPlanId}'`,
    );
    expect(await own(client, 'plans', teamPlanId)).toBe(1);
    expect(await own(client, 'plan_items', teamConceptId)).toBe(1);
    expect(await read(client, 'plan_items', teamDraftItemId)).toBe(0);
    expect(await own(agency, 'plan_items', teamDraftItemId)).toBe(1);
  });
});
