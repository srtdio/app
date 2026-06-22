// Integration coverage for @srtdio/comments against a local Supabase stack.
// Exercises createComment (through the comment_create proc) followed by the
// direct, RLS-scoped listComments and searchComments reads, all as the
// AUTHENTICATED role. The service-role admin client is used only to seed
// fixtures, mirroring the RLS / RPC suites (see packages/test-utils/rls.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
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
import {
  createComment,
  listComments,
  searchComments,
  type Client,
  type CommentResult,
} from '../../packages/comments/src/index';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';

function expectOk<T>(result: CommentResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

describe.runIf(COMMENTS_SUITE)('comments create + read layer (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let member: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let ownerClient: Client;

  async function addMember(workspaceId: string, user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Comments A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);
    ownerClient = clientFor(owner.id);

    member = await seedUser(env, admin);
    await addMember(wsA.id, member, 'agency');
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA], [owner, member]);
  });

  it('createComment writes a top-level comment and returns its id', async () => {
    const id = expectOk(
      await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        body: 'first pass looks solid',
        trace_id: generateTraceId(),
      }),
    );
    expect(typeof id).toBe('string');
  });

  it('createComment threads a reply under a parent', async () => {
    const id = expectOk(
      await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        parent_comment_id: ctxA.commentId,
        body: 'replying on the thread',
        trace_id: generateTraceId(),
      }),
    );
    expect(typeof id).toBe('string');
  });

  it('createComment stores validated body mentions', async () => {
    const id = expectOk(
      await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        body: `nice work @[${member.id}]`,
        trace_id: generateTraceId(),
      }),
    );
    const res = await asGeneric(admin).from('comments').select('mentions').eq('id', id);
    const rows = res.data as Array<{ mentions: string[] | null }> | null;
    expect(rows?.[0]?.mentions).toEqual([member.id]);
  });

  it('createComment records a decision', async () => {
    const id = expectOk(
      await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        body: 'approved direction: ship the carousel',
        is_decision: true,
        trace_id: generateTraceId(),
      }),
    );
    const res = await asGeneric(admin).from('comments').select('is_decision').eq('id', id);
    const rows = res.data as Array<{ is_decision: boolean }> | null;
    expect(rows?.[0]?.is_decision).toBe(true);
  });

  it('listComments returns the entity thread newest-first', async () => {
    const rows = expectOk(
      await listComments(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
      }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.entity_id).toBe(ctxA.postId);
      expect(row.deleted_at).toBeNull();
    }
    const times = rows.map((r) => r.created_at);
    const sorted = [...times].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(times).toEqual(sorted);
  });

  it('listComments filters by is_decision', async () => {
    const rows = expectOk(
      await listComments(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        is_decision: true,
      }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row.is_decision).toBe(true);
  });

  it('listComments filters by author', async () => {
    const rows = expectOk(
      await listComments(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        author: owner.id,
      }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row.author_user_id).toBe(owner.id);
  });

  it('searchComments matches a body token via FTS', async () => {
    expectOk(
      await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        body: 'the kerning on the headline needs tightening',
        trace_id: generateTraceId(),
      }),
    );
    const rows = expectOk(
      await searchComments(ownerClient, { workspace_id: wsA.id, query: 'kerning' }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.body.includes('kerning'))).toBe(true);
  });
});

// Regression: comment_create binds attachments by asset_VERSION id (the composer
// passes version ids in p_attachment_asset_ids). A version in the comment's own
// workspace whose asset is live attaches; a version belonging to another
// workspace is rejected as invalid_payload and writes no asset_attachments row.
describe.runIf(COMMENTS_SUITE)('comment_create attachment binding (version ids)', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let ctxA: Ctx;
  let ownerClient: Client;

  // Seed an asset + one version through the service role only, mirroring the
  // upload pipeline, and pin the asset's current_version_id. Returns both ids.
  async function seedAssetVersion(
    workspaceId: string,
  ): Promise<{ assetId: string; versionId: string }> {
    const g = asGeneric(admin);
    const asset = await insertRow(g, 'assets', {
      workspace_id: workspaceId,
      filename: 'attachment.png',
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
      size_bytes: 1234,
      uploaded_by: owner.id,
    });
    await g.from('assets').update({ current_version_id: version.id }).eq('id', String(asset.id));
    return { assetId: String(asset.id), versionId: String(version.id) };
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Attach A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);
    ownerClient = clientFor(owner.id);

    // A second workspace (also owned by the same user) supplies a foreign version.
    wsB = await seedWorkspace(admin, owner, `Attach B ${owner.email}`);
    await seedScaffold(admin, wsB);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner]);
  });

  it('binds a same-workspace version to an asset_attachments row', async () => {
    const { assetId, versionId } = await seedAssetVersion(wsA.id);
    const id = expectOk(
      await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: ctxA.postId,
        body: 'see the attached version',
        attachment_asset_ids: [versionId],
        trace_id: generateTraceId(),
      }),
    );
    const res = await asGeneric(admin)
      .from('asset_attachments')
      .select('asset_id, asset_version_id')
      .eq('entity_type', 'comment')
      .eq('entity_id', id);
    const rows = res.data as Array<{ asset_id: string; asset_version_id: string }> | null;
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.asset_version_id).toBe(versionId);
    expect(rows?.[0]?.asset_id).toBe(assetId);
  });

  it('rejects a foreign-workspace version with invalid_payload and writes nothing', async () => {
    const { versionId } = await seedAssetVersion(wsB.id);
    const result = await createComment(ownerClient, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      body: 'attaching a foreign version',
      attachment_asset_ids: [versionId],
      trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
    const written = await countWhere(asGeneric(admin), 'asset_attachments', [
      ['entity_type', 'comment'],
      ['asset_version_id', versionId],
    ]);
    expect(written).toBe(0);
  });
});
