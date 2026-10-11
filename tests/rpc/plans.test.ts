// Plan procs (20261009110000_plans_core.sql), exercised as the AUTHENTICATED
// role. The service-role admin client only seeds members, posts and assets and
// reads audit_log back; the plan tables grant service_role no SELECT (live
// parity), so plan state is read back as an agency member through RLS.
//
// Covered: a client cannot create a plan (forbidden_role); a draft goes into a
// client plan and is audited (20261011011500_plan_drafts_in_client_plans
// dropped plan_has_drafts); sharing a team plan that holds a draft succeeds, is
// one-way and stays forbidden_role for a client; a client review on a post item says use_stage_transition; a client review on a team
// plan is forbidden_role; a concept edit resets both reviews to waiting;
// reorder rejects a wrong-length list; a chat-origin file is 'attachment not
// available'; every success writes one audit_log row named after the proc.
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

const RPC_SUITE = process.env.RPC_SUITE === '1';

type Rpc = Database['public']['Functions'];
type ProcName =
  | 'plan_create'
  | 'plan_update'
  | 'plan_share_with_client'
  | 'plan_delete'
  | 'plan_concept_add'
  | 'plan_concept_edit'
  | 'plan_posts_add'
  | 'plan_item_remove'
  | 'plan_items_reorder'
  | 'plan_item_review';

interface Outcome<T> {
  data: T | null;
  error: { message: string } | null;
  traceId: string;
}

describe.runIf(RPC_SUITE)('plan procs (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let ws: SeededWorkspace;
  let bucketId: string;

  /**
   * Call one plan proc as `user` with a fresh uuid v7 trace (passed as the
   * proc's own p_trace_id; callRpc() is the app wrapper and does not apply).
   */
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

  /** Exactly one audit_log row for this success, action = the proc name. */
  async function expectAudited<T>(proc: ProcName, outcome: Outcome<T>): Promise<void> {
    expect(outcome.error).toBeNull();
    expect(await countWhere(g, 'audit_log', [['trace_id', outcome.traceId]])).toBe(1);
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', outcome.traceId],
        ['action', proc],
        ['outcome', 'success'],
      ]),
    ).toBe(1);
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

  function planArgs(audience: 'team' | 'client') {
    return {
      p_workspace_id: ws.id,
      p_title: `Plan ${randomSuffix()}`,
      p_starts_on: '2026-11-01',
      p_ends_on: '2026-11-30',
      p_audience: audience,
    };
  }

  async function newPlan(audience: 'team' | 'client'): Promise<string> {
    return ok('plan_create', await call(agency, 'plan_create', planArgs(audience)));
  }

  async function newConcept(planId: string): Promise<string> {
    return ok(
      'plan_concept_add',
      await call(agency, 'plan_concept_add', {
        p_plan_id: planId,
        p_title: 'Concept',
        p_description: 'Idea',
        p_attachment_version_ids: [],
      }),
    );
  }

  async function planRow(planId: string) {
    const res = await clientFor(agency.id)
      .from('plans')
      .select('audience, shared_with_client_at')
      .eq('id', planId)
      .single();
    if (res.error !== null) throw new Error(`plans read failed: ${res.error.message}`);
    return res.data;
  }

  async function itemsOf(planId: string) {
    const res = await clientFor(agency.id)
      .from('plan_items')
      .select('id, post_id, position')
      .eq('plan_id', planId)
      .order('position');
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    return res.data;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan procs ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
  });

  it('plan_create: a client is forbidden_role; agency succeeds and is audited', async () => {
    refusedWith(await call(client, 'plan_create', planArgs('team')), 'forbidden_role');
    const created = await call(agency, 'plan_create', planArgs('client'));
    await expectAudited('plan_create', created);
    expect((await planRow(String(created.data))).audience).toBe('client');
  });

  it('plan_update succeeds and is audited', async () => {
    const planId = await newPlan('team');
    await expectAudited(
      'plan_update',
      await call(agency, 'plan_update', {
        p_plan_id: planId,
        p_title: 'Renamed',
        p_starts_on: '2026-11-02',
        p_ends_on: '2026-11-20',
      }),
    );
  });

  it('plan_posts_add: a draft into a client plan is added and audited', async () => {
    const planId = await newPlan('client');
    const draft = await seedPost('draft');
    const added = await call(agency, 'plan_posts_add', { p_plan_id: planId, p_post_ids: [draft] });
    await expectAudited('plan_posts_add', added);
    expect(added.data).toBe(1);
    expect((await itemsOf(planId)).map((i) => i.post_id)).toEqual([draft]);
  });

  it('plan_share_with_client: succeeds while a draft is inside, is one-way, and is forbidden_role for a client', async () => {
    const planId = await newPlan('team');
    const draft = await seedPost('draft');
    ok(
      'plan_posts_add',
      await call(agency, 'plan_posts_add', { p_plan_id: planId, p_post_ids: [draft] }),
    );
    refusedWith(
      await call(client, 'plan_share_with_client', { p_plan_id: planId }),
      'forbidden_role',
    );
    expect((await planRow(planId)).audience).toBe('team');

    await expectAudited(
      'plan_share_with_client',
      await call(agency, 'plan_share_with_client', { p_plan_id: planId }),
    );
    const shared = await planRow(planId);
    expect(shared.audience).toBe('client');
    expect(shared.shared_with_client_at).not.toBeNull();
    expect((await itemsOf(planId)).map((i) => i.post_id)).toEqual([draft]);

    // One-way: a second share is a no-op (no audit row) and the plan stays shared.
    const again = await call(agency, 'plan_share_with_client', { p_plan_id: planId });
    expect(again.error).toBeNull();
    expect(await countWhere(g, 'audit_log', [['trace_id', again.traceId]])).toBe(0);
    expect(await planRow(planId)).toEqual(shared);
    // A client still cannot share (or reshare) it.
    refusedWith(
      await call(client, 'plan_share_with_client', { p_plan_id: planId }),
      'forbidden_role',
    );
  });

  it('plan_item_review: a client review on a post item is use_stage_transition', async () => {
    const planId = await newPlan('client');
    ok(
      'plan_posts_add',
      await call(agency, 'plan_posts_add', {
        p_plan_id: planId,
        p_post_ids: [await seedPost('review')],
      }),
    );
    const [item] = await itemsOf(planId);
    if (item === undefined) throw new Error('no item');
    refusedWith(
      await call(client, 'plan_item_review', {
        p_item_id: item.id,
        p_side: 'client',
        p_status: 'approved',
      }),
      'use_stage_transition',
    );
  });

  it('plan_item_review: a client review on a team plan is forbidden_role', async () => {
    const concept = await newConcept(await newPlan('team'));
    refusedWith(
      await call(client, 'plan_item_review', {
        p_item_id: concept,
        p_side: 'client',
        p_status: 'approved',
      }),
      'forbidden_role',
    );
  });

  it('plan_concept_edit resets both review rows to waiting', async () => {
    const concept = await newConcept(await newPlan('client'));
    await expectAudited(
      'plan_item_review',
      await call(agency, 'plan_item_review', {
        p_item_id: concept,
        p_side: 'team',
        p_status: 'approved',
      }),
    );
    await expectAudited(
      'plan_item_review',
      await call(client, 'plan_item_review', {
        p_item_id: concept,
        p_side: 'client',
        p_status: 'changes',
      }),
    );
    await expectAudited(
      'plan_concept_edit',
      await call(agency, 'plan_concept_edit', {
        p_item_id: concept,
        p_title: 'Concept v2',
        p_description: 'Reworked',
        p_attachment_version_ids: [],
      }),
    );
    const res = await clientFor(agency.id)
      .from('plan_item_reviews')
      .select('side, status')
      .eq('item_id', concept)
      .order('side');
    if (res.error !== null) throw new Error(`reviews read failed: ${res.error.message}`);
    expect(res.data).toEqual([
      { side: 'client', status: 'waiting' },
      { side: 'team', status: 'waiting' },
    ]);
  });

  it('plan_items_reorder rejects a wrong-length list; the exact list succeeds', async () => {
    const planId = await newPlan('team');
    const a = await newConcept(planId);
    const b = await newConcept(planId);
    refusedWith(
      await call(agency, 'plan_items_reorder', { p_plan_id: planId, p_item_ids: [b] }),
      'invalid_payload',
    );
    refusedWith(
      await call(agency, 'plan_items_reorder', { p_plan_id: planId, p_item_ids: [b, a, a] }),
      'invalid_payload',
    );
    await expectAudited(
      'plan_items_reorder',
      await call(agency, 'plan_items_reorder', { p_plan_id: planId, p_item_ids: [b, a] }),
    );
    expect((await itemsOf(planId)).map((i) => i.id)).toEqual([b, a]);
  });

  it("plan_concept_add with a chat-origin version is 'attachment not available'; a library one is audited", async () => {
    const planId = await newPlan('team');
    const chatFile = await seedAsset(g, ws.id, owner.id, 'chat');
    refusedWith(
      await call(agency, 'plan_concept_add', {
        p_plan_id: planId,
        p_title: 'With a chat file',
        p_description: '',
        p_attachment_version_ids: [chatFile.versionId],
      }),
      'attachment not available',
    );
    const libraryFile = await seedAsset(g, ws.id, owner.id, 'library');
    const added = await call(agency, 'plan_concept_add', {
      p_plan_id: planId,
      p_title: 'With a library file',
      p_description: '',
      p_attachment_version_ids: [libraryFile.versionId],
    });
    await expectAudited('plan_concept_add', added);
    expect(
      await countWhere(g, 'asset_attachments', [
        ['entity_type', 'plan_item'],
        ['entity_id', String(added.data)],
      ]),
    ).toBe(1);
  });

  it('plan_delete soft-deletes and is audited', async () => {
    const planId = await newPlan('team');
    await expectAudited('plan_delete', await call(agency, 'plan_delete', { p_plan_id: planId }));
    const res = await clientFor(agency.id).from('plans').select('id').eq('id', planId);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });
});
