// posts_select_member draft clause (20261009080000_posts_select_member_draft_clause.sql):
// an active member reads non-deleted posts; a draft is visible only to owner,
// admin and agency. A client sees review, approved, parked and rejected but no
// draft. An inactive member and a client of another workspace see nothing.
// Comments and asset attachments on a draft post are invisible to the client.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  ownReadCount,
  randomSuffix,
  seedAsset,
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

const STAGES = ['draft', 'review', 'approved', 'parked', 'rejected'] as const;
type Stage = (typeof STAGES)[number];
const VISIBLE_TO_CLIENT: readonly Stage[] = ['review', 'approved', 'parked', 'rejected'];

describe.runIf(RLS_SUITE)('posts_select_member draft visibility', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let adminUser: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let inactive: SeededUser;
  let outsider: SeededUser;
  let outsiderClient: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  const postIds = {} as Record<Stage, string>;
  let draftCommentId: string;
  let reviewCommentId: string;
  let draftAttachmentId: string;

  async function seedPost(bucketId: string, stage: Stage): Promise<string> {
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

  async function seedComment(postId: string): Promise<string> {
    const comment = await insertRow(g, 'comments', {
      workspace_id: ws.id,
      entity_type: 'post',
      entity_id: postId,
      author_user_id: owner.id,
      body: 'comment',
    });
    return String(comment.id);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    adminUser = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    inactive = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    outsiderClient = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Draft visibility ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Draft visibility other ${outsider.email}`);
    await seedMember(g, ws, adminUser, 'admin');
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, other, outsiderClient, 'client');
    // Inactive agency member: would see drafts if active, so a 0 is the active check.
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
    for (const stage of STAGES) postIds[stage] = await seedPost(String(bucket.id), stage);
    draftCommentId = await seedComment(postIds.draft);
    reviewCommentId = await seedComment(postIds.review);
    const asset = await seedAsset(g, ws.id, owner.id);
    const attachment = await insertRow(g, 'asset_attachments', {
      asset_id: asset.assetId,
      asset_version_id: asset.versionId,
      entity_type: 'post',
      entity_id: postIds.draft,
      workspace_id: ws.id,
      attached_by: owner.id,
    });
    draftAttachmentId = String(attachment.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [ws, other],
      [owner, adminUser, agency, client, inactive, outsider, outsiderClient],
    );
  });

  function readPost(user: SeededUser, stage: Stage): Promise<number> {
    return visibleRowCount(asGeneric(clientFor(user.id)), 'posts', [['id', postIds[stage]]]);
  }

  it('client member: draft post returns 0 rows', async () => {
    expect(await readPost(client, 'draft')).toBe(0);
  });

  it.each(VISIBLE_TO_CLIENT)('client member: %s post is visible', async (stage) => {
    expect(
      await ownReadCount(asGeneric(clientFor(client.id)), 'posts', [['id', postIds[stage]]]),
    ).toBe(1);
  });

  it.each([
    ['owner', () => owner],
    ['admin', () => adminUser],
    ['agency', () => agency],
  ] as const)('%s: draft post is visible', async (_role, user) => {
    expect(
      await ownReadCount(asGeneric(clientFor(user().id)), 'posts', [['id', postIds.draft]]),
    ).toBe(1);
  });

  it.each(STAGES)('inactive member: %s post is not visible', async (stage) => {
    expect(await readPost(inactive, stage)).toBe(0);
  });

  it.each(STAGES)("other workspace's client: %s post is not visible", async (stage) => {
    expect(await readPost(outsiderClient, stage)).toBe(0);
  });

  it('comments on a draft post are invisible to the client', async () => {
    const asClient = asGeneric(clientFor(client.id));
    // Positive controls: the client's comment read path works, and the owner sees the draft comment.
    expect(await ownReadCount(asClient, 'comments', [['id', reviewCommentId]])).toBe(1);
    expect(
      await ownReadCount(asGeneric(clientFor(owner.id)), 'comments', [['id', draftCommentId]]),
    ).toBe(1);
    expect(await visibleRowCount(asClient, 'comments', [['id', draftCommentId]])).toBe(0);
  });

  it('asset attachment on a draft post is invisible to the client, visible to agency', async () => {
    const match: [string, string][] = [['id', draftAttachmentId]];
    expect(await ownReadCount(asGeneric(clientFor(agency.id)), 'asset_attachments', match)).toBe(1);
    expect(await visibleRowCount(asGeneric(clientFor(client.id)), 'asset_attachments', match)).toBe(
      0,
    );
  });
});
