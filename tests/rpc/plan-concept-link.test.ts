// plan_concept_link_post and the linked post in plan_bundle_read
// (20261104140000_plan_concept_link_post.sql), exercised as the AUTHENTICATED
// role. The service-role admin client only seeds members and posts, reads
// posts, audit_log and inbox_entries back, and hard-deletes one post (the ON
// DELETE SET NULL check); plan rows are read as the agency (RLS), as the plan
// tables grant service_role nothing.
//
// Covered: the agency links and unlinks (audit row each, same value a no-op);
// a client is forbidden_role; an unapproved concept is concept_not_approved; a
// post from another workspace and a soft-deleted post are invalid_payload; a
// post item is invalid_payload; a second concept linking the same post in the
// same plan is post_already_linked; link and unlink leave the concept's
// reviews, its comments and the post's stage untouched and notify no one; a
// post's hard delete clears linked_post_id and keeps the concept;
// plan_bundle_read returns linked_post_id and the linked post (deleted false).

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
  | 'plan_item_review'
  | 'plan_item_comment_create'
  | 'post_soft_delete'
  | 'plan_bundle_read';

interface Outcome<T> {
  data: T | null;
  error: { message: string } | null;
  traceId: string;
}

interface BundleItem {
  id: string;
  kind: string;
  post_id: string | null;
  linked_post_id: string | null;
}

interface BundlePost {
  id: string;
  stage: string;
  title: string | null;
  deleted: boolean;
}

describe.runIf(RPC_SUITE)('plan concept link (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let bucketId: string;
  let otherBucketId: string;
  let otherOwner: string;

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

  /** plan_concept_link_post; null unlinks (the generated Args type p_post_id as a string). */
  async function link(
    user: SeededUser,
    itemId: string,
    postId: string | null,
  ): Promise<Outcome<null>> {
    const traceId = uuidv7();
    const res = await clientFor(user.id).rpc('plan_concept_link_post', {
      p_item_id: itemId,
      p_post_id: postId,
      p_trace_id: traceId,
    } as unknown as Rpc['plan_concept_link_post']['Args']);
    return {
      data: null,
      error: res.error === null ? null : { message: res.error.message },
      traceId,
    };
  }

  function ok<T>(proc: string, outcome: Outcome<T>): T {
    if (outcome.error !== null) throw new Error(`${proc} failed: ${outcome.error.message}`);
    return outcome.data as T;
  }

  async function seedPost(
    stage: string,
    workspace: SeededWorkspace = ws,
    bucket: string = bucketId,
  ): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: workspace.id,
      number: await nextEntityNumber(g, workspace.id),
      title: `Post ${randomSuffix()}`,
      bucket_id: bucket,
      owner_user_id: workspace.id === ws.id ? owner.id : otherOwner,
      platform: 'linkedin',
      format: 'text',
      stage,
      created_by: workspace.id === ws.id ? owner.id : otherOwner,
    });
    return String(post.id);
  }

  async function newPlan(): Promise<string> {
    return ok(
      'plan_create',
      await call(agency, 'plan_create', {
        p_workspace_id: ws.id,
        p_title: `Plan ${randomSuffix()}`,
        p_starts_on: '2026-11-01',
        p_ends_on: '2026-11-30',
        p_audience: 'client',
      }),
    );
  }

  async function newConcept(planId: string, approved: boolean): Promise<string> {
    const itemId = ok(
      'plan_concept_add',
      await call(agency, 'plan_concept_add', {
        p_plan_id: planId,
        p_title: `Concept ${randomSuffix()}`,
        p_description: 'A concept',
        p_attachment_version_ids: [],
        p_target_date: '2026-11-06',
      }),
    );
    if (approved) {
      ok(
        'plan_item_review',
        await call(client, 'plan_item_review', {
          p_item_id: itemId,
          p_side: 'client',
          p_status: 'approved',
        }),
      );
    }
    return itemId;
  }

  async function itemRow(itemId: string): Promise<{
    linked_post_id: string | null;
    deleted_at: string | null;
  }> {
    const res = await clientFor(agency.id)
      .from('plan_items')
      .select('linked_post_id, deleted_at')
      .eq('id', itemId)
      .single();
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    return res.data;
  }

  async function stageOf(postId: string): Promise<string> {
    const res = await admin.from('posts').select('stage').eq('id', postId).single();
    if (res.error !== null) throw new Error(`posts read failed: ${res.error.message}`);
    return res.data.stage;
  }

  /** The concept's reviews and live comments, as a comparable snapshot. */
  async function snapshot(itemId: string): Promise<string> {
    const reviews = await clientFor(agency.id)
      .from('plan_item_reviews')
      .select('side, status, reviewed_by, reviewed_at')
      .eq('item_id', itemId)
      .order('side');
    const comments = await clientFor(agency.id)
      .from('plan_item_comments')
      .select('id, body, visibility, deleted_at, edited_at')
      .eq('item_id', itemId)
      .order('id');
    if (reviews.error !== null || comments.error !== null) throw new Error('snapshot read failed');
    return JSON.stringify({ reviews: reviews.data, comments: comments.data });
  }

  async function inboxCount(): Promise<number> {
    const res = await admin
      .from('inbox_entries')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.id);
    if (res.error !== null) throw new Error(`inbox_entries read failed: ${res.error.message}`);
    return res.count ?? 0;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Concept link ${owner.email}`);
    // One workspace per owner: the other workspace has its own owner.
    const stranger = await seedUser(env, admin);
    other = await seedWorkspace(admin, stranger, `Concept link other ${stranger.email}`);
    otherOwner = stranger.id;
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
    const otherBucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: other.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    otherBucketId = String(otherBucket.id);
  });

  it('the agency links and unlinks; each writes one audit row; the same value is a no-op', async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, true);
    const postId = await seedPost('review');
    const linked = await link(agency, conceptId, postId);
    expect(linked.error).toBeNull();
    expect((await itemRow(conceptId)).linked_post_id).toBe(postId);
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', linked.traceId],
        ['action', 'plan_concept_link_post'],
      ]),
    ).toBe(1);
    const again = await link(agency, conceptId, postId);
    expect(again.error).toBeNull();
    expect(await countWhere(g, 'audit_log', [['trace_id', again.traceId]])).toBe(0);
    const unlinked = await link(agency, conceptId, null);
    expect(unlinked.error).toBeNull();
    expect((await itemRow(conceptId)).linked_post_id).toBeNull();
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', unlinked.traceId],
        ['action', 'plan_concept_link_post'],
      ]),
    ).toBe(1);
  });

  it('a client is forbidden_role', async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, true);
    const postId = await seedPost('review');
    expect((await link(client, conceptId, postId)).error?.message).toBe('forbidden_role');
    expect((await itemRow(conceptId)).linked_post_id).toBeNull();
  });

  it('an unapproved concept is concept_not_approved', async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, false);
    const postId = await seedPost('review');
    expect((await link(agency, conceptId, postId)).error?.message).toBe('concept_not_approved');
  });

  it('a post from another workspace and a soft-deleted post are invalid_payload', async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, true);
    const foreign = await seedPost('review', other, otherBucketId);
    expect((await link(agency, conceptId, foreign)).error?.message).toBe('invalid_payload');
    const gone = await seedPost('review');
    ok('post_soft_delete', await call(agency, 'post_soft_delete', { p_post_id: gone }));
    expect((await link(agency, conceptId, gone)).error?.message).toBe('invalid_payload');
    expect((await itemRow(conceptId)).linked_post_id).toBeNull();
  });

  it('a post item is invalid_payload', async () => {
    const planId = await newPlan();
    const postId = await seedPost('review');
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
    if (res.error !== null) throw new Error(res.error.message);
    const other = await seedPost('review');
    expect((await link(agency, String(res.data.id), other)).error?.message).toBe('invalid_payload');
  });

  it('a second concept linking the same post in the same plan is post_already_linked', async () => {
    const planId = await newPlan();
    const first = await newConcept(planId, true);
    const second = await newConcept(planId, true);
    const postId = await seedPost('review');
    expect((await link(agency, first, postId)).error).toBeNull();
    expect((await link(agency, second, postId)).error?.message).toBe('post_already_linked');
    expect((await itemRow(second)).linked_post_id).toBeNull();
    // Another plan may link the same post.
    const otherPlan = await newPlan();
    const third = await newConcept(otherPlan, true);
    expect((await link(agency, third, postId)).error).toBeNull();
  });

  it("link and unlink leave the concept's reviews, comments and the post's stage alone, and notify no one", async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, true);
    ok(
      'plan_item_comment_create',
      await call(agency, 'plan_item_comment_create', {
        p_item_id: conceptId,
        p_body: 'A note',
        p_visibility: 'everyone',
      }),
    );
    const postId = await seedPost('review');
    const before = await snapshot(conceptId);
    const inboxBefore = await inboxCount();
    expect((await link(agency, conceptId, postId)).error).toBeNull();
    expect(await snapshot(conceptId)).toBe(before);
    expect(await stageOf(postId)).toBe('review');
    expect((await link(agency, conceptId, null)).error).toBeNull();
    expect(await snapshot(conceptId)).toBe(before);
    expect(await stageOf(postId)).toBe('review');
    expect(await inboxCount()).toBe(inboxBefore);
  });

  it("a post's hard delete clears linked_post_id and keeps the concept", async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, true);
    const postId = await seedPost('review');
    expect((await link(agency, conceptId, postId)).error).toBeNull();
    const del = await admin.from('posts').delete().eq('id', postId);
    if (del.error !== null) throw new Error(`posts delete failed: ${del.error.message}`);
    const row = await itemRow(conceptId);
    expect(row.linked_post_id).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it('plan_bundle_read returns linked_post_id and the linked post', async () => {
    const planId = await newPlan();
    const conceptId = await newConcept(planId, true);
    const postId = await seedPost('approved');
    expect((await link(agency, conceptId, postId)).error).toBeNull();
    const read = ok(
      'plan_bundle_read',
      await call(agency, 'plan_bundle_read', { p_workspace_id: ws.id, p_plan_ids: [planId] }),
    ) as unknown as { items: BundleItem[]; posts: BundlePost[] };
    const concept = read.items.find((i) => i.id === conceptId);
    expect(concept?.kind).toBe('concept');
    expect(concept?.linked_post_id).toBe(postId);
    const post = read.posts.find((p) => p.id === postId);
    expect(post).toMatchObject({ id: postId, stage: 'approved', deleted: false });
    // The client reads the same link and post (an approved post is readable).
    const clientRead = ok(
      'plan_bundle_read',
      await call(client, 'plan_bundle_read', { p_workspace_id: ws.id, p_plan_ids: [planId] }),
    ) as unknown as { items: BundleItem[]; posts: BundlePost[] };
    expect(clientRead.items.find((i) => i.id === conceptId)?.linked_post_id).toBe(postId);
    expect(clientRead.posts.some((p) => p.id === postId)).toBe(true);
  });
});
