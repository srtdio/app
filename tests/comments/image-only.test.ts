// Regression coverage for image-only comments: comments.body stays NOT NULL but
// may be an empty string when the comment carries at least one attachment.
// comment_create enforces the same rule, rejecting an empty or whitespace-only
// body when no attachment is present. Exercised through createComment (the
// comment_create proc) as the AUTHENTICATED role; the service-role admin client
// seeds fixtures only, mirroring the integration / RLS suites.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  randomSha256,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import { createComment, type Client, type CommentResult } from '../../packages/comments/src/index';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';

describe.runIf(COMMENTS_SUITE)(
  'comment_create image-only comments (body NOT NULL, empty allowed)',
  () => {
    let admin: SupabaseClient<Database>;
    let owner: SeededUser;
    let ws: SeededWorkspace;
    let ctx: Ctx;
    let ownerClient: Client;

    // Seed an asset + one image version through the service role only, mirroring
    // the upload pipeline, and pin the asset's current_version_id. Returns both ids.
    async function seedAssetVersion(
      workspaceId: string,
    ): Promise<{ assetId: string; versionId: string }> {
      const g = asGeneric(admin);
      const asset = await insertRow(g, 'assets', {
        workspace_id: workspaceId,
        filename: 'image-only.png',
        uploaded_by: owner.id,
      });
      const version = await insertRow(g, 'asset_versions', {
        asset_id: asset.id,
        workspace_id: workspaceId,
        version_number: 1,
        kind: 'image',
        r2_key: `key/${crypto.randomUUID()}`,
        mime_type: 'image/png',
        sha256: randomSha256(),
        size_bytes: 2048,
        uploaded_by: owner.id,
      });
      await g.from('assets').update({ current_version_id: version.id }).eq('id', String(asset.id));
      return { assetId: String(asset.id), versionId: String(version.id) };
    }

    beforeAll(async () => {
      const env = loadRlsEnv();
      admin = createAdminClient(env);

      owner = await seedUser(env, admin);
      ws = await seedWorkspace(admin, owner, `ImageOnly ${owner.email}`);
      ctx = await seedScaffold(admin, ws);
      ownerClient = clientFor(owner.id);
    });

    afterAll(async () => {
      await cleanupWorkspaces(admin, [ws], [owner]);
    });

    it('image-only comment (empty body + attachment) is accepted and stores empty body', async () => {
      const { versionId } = await seedAssetVersion(ws.id);
      const result: CommentResult<string> = await createComment(ownerClient, {
        workspace_id: ws.id,
        entity_type: 'post',
        entity_id: ctx.postId,
        body: '',
        attachment_asset_ids: [versionId],
        trace_id: generateTraceId(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = await asGeneric(admin).from('comments').select('body').eq('id', result.data);
      const rows = row.data as Array<{ body: string }> | null;
      expect(rows?.[0]?.body).toBe('');

      const att = await asGeneric(admin)
        .from('asset_attachments')
        .select('asset_version_id')
        .eq('entity_type', 'comment')
        .eq('entity_id', result.data);
      const attRows = att.data as Array<{ asset_version_id: string }> | null;
      expect(attRows?.length).toBe(1);
      expect(attRows?.[0]?.asset_version_id).toBe(versionId);
    });

    it('empty body with no attachment is rejected (invalid_payload)', async () => {
      const result = await createComment(ownerClient, {
        workspace_id: ws.id,
        entity_type: 'post',
        entity_id: ctx.postId,
        body: '',
        attachment_asset_ids: [],
        trace_id: generateTraceId(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_payload');
    });

    it('whitespace-only body with no attachment is rejected (invalid_payload)', async () => {
      const result = await createComment(ownerClient, {
        workspace_id: ws.id,
        entity_type: 'post',
        entity_id: ctx.postId,
        body: '   ',
        attachment_asset_ids: [],
        trace_id: generateTraceId(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_payload');
    });
  },
);
