// Regression coverage for the asset_attachments display-name trigger
// (asset_attachment_set_display_name). The trigger's boundary is an INSERT into
// asset_attachments, so the suite exercises it by inserting attachment rows
// directly via the service-role admin client (the same privileged path the app
// reaches through SECURITY DEFINER procs) and reading assets.display_name back
// as ground truth. Mirrors the seed/teardown model of procs.test.ts.
//
// The trigger fills a blank assets.display_name from the attachment's parent
// title (post -> title; brief -> title + ' (brief)'; comment -> the comment's
// owning post/brief title + ' (comment)') and never overwrites a non-blank name.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  randomSha256,
  seedUser,
  seedWorkspace,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

describe.runIf(RPC_SUITE)('asset_attachments display-name trigger', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let ws: SeededWorkspace;

  let postId: string;
  let briefId: string;
  let commentId: string;

  interface SeededAsset {
    assetId: string;
    versionId: string;
  }

  // An asset with a pinned current version, ready to be attached. `displayName`
  // pre-seeds assets.display_name (used by the blank-only guard test).
  async function seedAsset(displayName?: string): Promise<SeededAsset> {
    const asset = await insertRow(asGeneric(admin), 'assets', {
      workspace_id: ws.id,
      filename: 'attach.png',
      uploaded_by: owner.id,
      ...(displayName === undefined ? {} : { display_name: displayName }),
    });
    const version = await insertRow(asGeneric(admin), 'asset_versions', {
      asset_id: asset.id,
      workspace_id: ws.id,
      version_number: 1,
      kind: 'image',
      r2_key: `k/${crypto.randomUUID()}`,
      mime_type: 'image/png',
      sha256: randomSha256(),
      size_bytes: 1,
      uploaded_by: owner.id,
    });
    await asGeneric(admin)
      .from('assets')
      .update({ current_version_id: version.id })
      .eq('id', String(asset.id));
    return { assetId: String(asset.id), versionId: String(version.id) };
  }

  // Attach a seeded asset to a parent entity (fires the trigger) and read back
  // the asset's display_name as ground truth.
  async function attachAndReadDisplayName(
    asset: SeededAsset,
    entityType: string,
    entityId: string,
  ): Promise<string | null> {
    await insertRow(asGeneric(admin), 'asset_attachments', {
      asset_id: asset.assetId,
      asset_version_id: asset.versionId,
      entity_type: entityType,
      entity_id: entityId,
      workspace_id: ws.id,
      attached_by: owner.id,
    });
    const res = await asGeneric(admin)
      .from('assets')
      .select('display_name')
      .eq('id', asset.assetId);
    const rows = res.data as Array<{ display_name: string | null }> | null;
    return rows?.[0]?.display_name ?? null;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `DisplayName ${owner.email}`);

    const post = await insertRow(asGeneric(admin), 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(asGeneric(admin), ws.id),
      title: 'Launch Post',
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: owner.id,
    });
    postId = String(post.id);

    const brief = await insertRow(asGeneric(admin), 'briefs', {
      workspace_id: ws.id,
      number: await nextEntityNumber(asGeneric(admin), ws.id),
      title: 'Spring Brief',
      objective: 'Objective',
      created_by: owner.id,
    });
    briefId = String(brief.id);

    const comment = await insertRow(asGeneric(admin), 'comments', {
      workspace_id: ws.id,
      entity_type: 'post',
      entity_id: postId,
      author_user_id: owner.id,
      body: 'first pass looks good',
    });
    commentId = String(comment.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner]);
  });

  it('post attachment: display_name becomes the post title', async () => {
    const asset = await seedAsset();
    expect(await attachAndReadDisplayName(asset, 'post', postId)).toBe('Launch Post');
  });

  it('brief attachment: display_name becomes the brief title + " (brief)"', async () => {
    const asset = await seedAsset();
    expect(await attachAndReadDisplayName(asset, 'brief', briefId)).toBe('Spring Brief (brief)');
  });

  it('comment attachment: display_name hops to the owning post title + " (comment)"', async () => {
    const asset = await seedAsset();
    expect(await attachAndReadDisplayName(asset, 'comment', commentId)).toBe(
      'Launch Post (comment)',
    );
  });

  it('blank-only guard: a pre-set display_name is never overwritten', async () => {
    const asset = await seedAsset('My Custom Name');
    expect(await attachAndReadDisplayName(asset, 'post', postId)).toBe('My Custom Name');
  });
});
