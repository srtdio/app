// Integration coverage for the feedback ledger (migration
// 20260716120000_feedback_ledger.sql) against a local Supabase stack, mirroring
// tests/comments/integration.test.ts: fixtures are seeded through the
// service-role admin client only, and every proc under test runs as the
// AUTHENTICATED role. comment_batch_create and the widened comment_resolve have
// no @srtdio/rpc wrapper yet, so they are invoked through the typed `.rpc()`
// surface directly, with p_trace_id always passed explicitly.

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
  nextEntityNumber,
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
import { createComment, editComment } from '../../packages/comments/src/index';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';

type Db = SupabaseClient<Database>;
type Functions = Database['public']['Functions'];
type BatchCreateArgs = Functions['comment_batch_create']['Args'];
type ResolveArgs = Functions['comment_resolve']['Args'];

/** One {id, seq} element of comment_batch_create's jsonb return value. */
interface CheckpointRef {
  id: string;
  seq: number;
}

/** The ledger-relevant columns of a comments row, read back via the admin client. */
interface LedgerRow {
  body: string;
  parent_comment_id: string | null;
  ledger_seq: number | null;
  ledger_batch_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  edited_at: string | null;
}

function batchCreate(client: Db, args: BatchCreateArgs) {
  return client.rpc('comment_batch_create', args);
}

function resolveComment(client: Db, args: ResolveArgs) {
  return client.rpc('comment_resolve', args);
}

/** A body of exactly n whitespace-separated words. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');
}

function asRefs(data: unknown): CheckpointRef[] {
  if (!Array.isArray(data)) throw new Error('expected a jsonb array of {id, seq}');
  return data as CheckpointRef[];
}

describe.runIf(COMMENTS_SUITE)('comment_batch_create (feedback ledger)', () => {
  let admin: Db;
  let owner: SeededUser;
  let clientUser: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let ctxA: Ctx;
  let clientClient: Db;
  let ownerClient: Db;
  let reviewPostId: string;
  let draftPostId: string;
  let attachPostId: string;
  let firstBatchId: string;

  async function insertPost(stage: string): Promise<string> {
    const g = asGeneric(admin);
    const row = await insertRow(g, 'posts', {
      workspace_id: wsA.id,
      number: await nextEntityNumber(g, wsA.id),
      title: 'Ledger post',
      bucket_id: ctxA.bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: owner.id,
      stage,
    });
    return String(row.id);
  }

  async function seedAssetVersion(
    workspaceId: string,
  ): Promise<{ assetId: string; versionId: string }> {
    const g = asGeneric(admin);
    const asset = await insertRow(g, 'assets', {
      workspace_id: workspaceId,
      filename: 'checkpoint.png',
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

  async function readLedgerRow(id: string): Promise<LedgerRow> {
    const res = await asGeneric(admin)
      .from('comments')
      .select(
        'body, parent_comment_id, ledger_seq, ledger_batch_id, resolved_at, resolved_by, resolution_note, edited_at',
      )
      .eq('id', id);
    if (res.error) throw new Error(`comments read failed: ${res.error.message}`);
    const rows = res.data as LedgerRow[] | null;
    const first = rows?.[0];
    if (!first) throw new Error(`comment ${id} not found`);
    return first;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Ledger A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);
    ownerClient = clientFor(owner.id);

    clientUser = await seedUser(env, admin);
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: wsA.id,
      user_id: clientUser.id,
      role: 'client',
      active: true,
      accepted_at: new Date().toISOString(),
    });
    clientClient = clientFor(clientUser.id);

    // A second workspace (same owner) supplies the foreign attachment version.
    wsB = await seedWorkspace(admin, owner, `Ledger B ${owner.email}`);

    reviewPostId = await insertPost('review');
    draftPostId = await insertPost('draft');
    attachPostId = await insertPost('review');
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner, clientUser]);
  });

  it('assigns seqs 1..N in point order and fans out one inbox entry per other member', async () => {
    const { data, error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: reviewPostId,
      p_points: [{ body: 'tighten the hook' }, { body: 'logo too small' }, { body: words(50) }],
      p_trace_id: generateTraceId(),
    });
    expect(error).toBeNull();
    const refs = asRefs(data);
    expect(refs.map((r) => r.seq)).toEqual([1, 2, 3]);

    const first = await readLedgerRow(refs[0]!.id);
    expect(first.body).toBe('tighten the hook');
    expect(first.parent_comment_id).toBeNull();
    expect(first.ledger_seq).toBe(1);
    expect(first.ledger_batch_id).not.toBeNull();
    firstBatchId = first.ledger_batch_id!;
    for (const ref of refs) {
      const row = await readLedgerRow(ref.id);
      expect(row.ledger_seq).toBe(ref.seq);
      expect(row.ledger_batch_id).toBe(firstBatchId);
    }

    // One 'checkpoints_added' entry for the other active member, none for the author.
    const ownerEntries = await countWhere(asGeneric(admin), 'inbox_entries', [
      ['event_type', 'checkpoints_added'],
      ['entity_id', reviewPostId],
      ['user_id', owner.id],
    ]);
    expect(ownerEntries).toBe(1);
    const authorEntries = await countWhere(asGeneric(admin), 'inbox_entries', [
      ['event_type', 'checkpoints_added'],
      ['entity_id', reviewPostId],
      ['user_id', clientUser.id],
    ]);
    expect(authorEntries).toBe(0);
  });

  it('a second batch continues the numbering from the post max', async () => {
    const { data, error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: reviewPostId,
      p_points: [{ body: 'swap slide two' }, { body: 'brighter thumbnail' }],
      p_trace_id: generateTraceId(),
    });
    expect(error).toBeNull();
    const refs = asRefs(data);
    expect(refs.map((r) => r.seq)).toEqual([4, 5]);
    const row = await readLedgerRow(refs[0]!.id);
    expect(row.ledger_batch_id).not.toBe(firstBatchId);
  });

  it('commits a single-point batch and returns its seq', async () => {
    const postId = await insertPost('review');
    const { data, error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: postId,
      p_points: [{ body: 'one and only point' }],
      p_trace_id: generateTraceId(),
    });
    expect(error).toBeNull();
    const refs = asRefs(data);
    expect(refs.map((r) => r.seq)).toEqual([1]);
    const row = await readLedgerRow(refs[0]!.id);
    expect(row.ledger_seq).toBe(1);
    expect(row.ledger_batch_id).not.toBeNull();
    // A fresh post numbers from 1: ledger_seq is per-post, not global.
    expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', postId]])).toBe(1);
  });

  it('commits a full 20-point batch and returns seqs 1..20', async () => {
    const postId = await insertPost('review');
    const points = Array.from({ length: 20 }, (_, i) => ({ body: `point ${i + 1}` }));
    const { data, error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: postId,
      p_points: points,
      p_trace_id: generateTraceId(),
    });
    expect(error).toBeNull();
    const refs = asRefs(data);
    expect(refs.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // All 20 committed under one batch id (the transaction was not rolled back).
    const rows = await Promise.all(refs.map((r) => readLedgerRow(r.id)));
    expect(new Set(rows.map((row) => row.ledger_batch_id)).size).toBe(1);
    expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', postId]])).toBe(20);
  });

  it('continues ledger_seq from the post max across batches, not per batch', async () => {
    const postId = await insertPost('review');
    const first = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: postId,
      p_points: [{ body: 'first' }, { body: 'second' }],
      p_trace_id: generateTraceId(),
    });
    expect(first.error).toBeNull();
    const firstRefs = asRefs(first.data);
    expect(firstRefs.map((r) => r.seq)).toEqual([1, 2]);

    const second = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: postId,
      p_points: [{ body: 'third' }],
      p_trace_id: generateTraceId(),
    });
    expect(second.error).toBeNull();
    const secondRefs = asRefs(second.data);
    // A new batch, but the seq keeps climbing from the post's max (2 -> 3).
    expect(secondRefs.map((r) => r.seq)).toEqual([3]);
    const firstRow = await readLedgerRow(firstRefs[0]!.id);
    const secondRow = await readLedgerRow(secondRefs[0]!.id);
    expect(secondRow.ledger_batch_id).not.toBe(firstRow.ledger_batch_id);
  });

  it('rejects a non-client caller with forbidden_role', async () => {
    const { error } = await batchCreate(ownerClient, {
      p_workspace_id: wsA.id,
      p_post_id: reviewPostId,
      p_points: [{ body: 'owner checkpoint' }],
      p_trace_id: generateTraceId(),
    });
    expect(error?.message).toBe('forbidden_role');
  });

  it('rejects a draft post with invalid_stage', async () => {
    const { error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: draftPostId,
      p_points: [{ body: 'too early' }],
      p_trace_id: generateTraceId(),
    });
    expect(error?.message).toBe('invalid_stage');
  });

  it('rejects an unknown post with not_found', async () => {
    const { error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: crypto.randomUUID(),
      p_points: [{ body: 'no such post' }],
      p_trace_id: generateTraceId(),
    });
    expect(error?.message).toBe('not_found');
  });

  it('rejects a 51-word point with invalid_payload and writes nothing', async () => {
    const { error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: reviewPostId,
      p_points: [{ body: 'still fine' }, { body: words(51) }],
      p_trace_id: generateTraceId(),
    });
    expect(error?.message).toBe('invalid_payload');
    // The whole batch rolled back: the post still carries exactly 5 checkpoints.
    expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', reviewPostId]])).toBe(5);
  });

  it('rejects 21 points with invalid_payload', async () => {
    const points = Array.from({ length: 21 }, (_, i) => ({ body: `point ${i + 1}` }));
    const { error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: reviewPostId,
      p_points: points,
      p_trace_id: generateTraceId(),
    });
    expect(error?.message).toBe('invalid_payload');
    expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', reviewPostId]])).toBe(5);
  });

  it('creates per-point asset_attachments rows for same-workspace version ids', async () => {
    const { assetId, versionId } = await seedAssetVersion(wsA.id);
    const { data, error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: attachPostId,
      p_points: [{ body: 'see the attached crop', attachment_version_ids: [versionId] }],
      p_trace_id: generateTraceId(),
    });
    expect(error).toBeNull();
    const refs = asRefs(data);
    expect(refs).toHaveLength(1);

    const res = await asGeneric(admin)
      .from('asset_attachments')
      .select('asset_id, asset_version_id, position, attached_by')
      .eq('entity_type', 'comment')
      .eq('entity_id', refs[0]!.id);
    const rows = res.data as Array<{
      asset_id: string;
      asset_version_id: string;
      position: number;
      attached_by: string;
    }> | null;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.asset_id).toBe(assetId);
    expect(rows?.[0]?.asset_version_id).toBe(versionId);
    expect(rows?.[0]?.position).toBe(0);
    expect(rows?.[0]?.attached_by).toBe(clientUser.id);
  });

  it('rejects a cross-workspace attachment version with invalid_payload and writes nothing', async () => {
    const { versionId } = await seedAssetVersion(wsB.id);
    const before = await countWhere(asGeneric(admin), 'comments', [['entity_id', attachPostId]]);
    const { error } = await batchCreate(clientClient, {
      p_workspace_id: wsA.id,
      p_post_id: attachPostId,
      p_points: [{ body: 'foreign attachment', attachment_version_ids: [versionId] }],
      p_trace_id: generateTraceId(),
    });
    expect(error?.message).toBe('invalid_payload');
    expect(
      await countWhere(asGeneric(admin), 'asset_attachments', [['asset_version_id', versionId]]),
    ).toBe(0);
    expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', attachPostId]])).toBe(
      before,
    );
  });

  describe('comment_resolve resolution notes', () => {
    let cp1: string;
    let cp2: string;
    let cp3: string;

    beforeAll(async () => {
      const postId = await insertPost('review');
      const { data, error } = await batchCreate(clientClient, {
        p_workspace_id: wsA.id,
        p_post_id: postId,
        p_points: [
          { body: 'note target' },
          { body: 'blank note target' },
          { body: 'long note target' },
        ],
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();
      const refs = asRefs(data);
      cp1 = refs[0]!.id;
      cp2 = refs[1]!.id;
      cp3 = refs[2]!.id;
    });

    it('stores the trimmed note on a real open-to-resolved transition and clears it on reopen', async () => {
      const resolved = await resolveComment(ownerClient, {
        p_comment_id: cp1,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: '  ship it  ',
      });
      expect(resolved.error).toBeNull();
      let row = await readLedgerRow(cp1);
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_by).toBe(owner.id);
      expect(row.resolution_note).toBe('ship it');

      // Resolving an already-resolved checkpoint is not a transition: the
      // original note survives.
      const again = await resolveComment(ownerClient, {
        p_comment_id: cp1,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: 'different note',
      });
      expect(again.error).toBeNull();
      row = await readLedgerRow(cp1);
      expect(row.resolution_note).toBe('ship it');

      const reopened = await resolveComment(ownerClient, {
        p_comment_id: cp1,
        p_resolved: false,
        p_trace_id: generateTraceId(),
      });
      expect(reopened.error).toBeNull();
      row = await readLedgerRow(cp1);
      expect(row.resolved_at).toBeNull();
      expect(row.resolved_by).toBeNull();
      expect(row.resolution_note).toBeNull();
    });

    it('stores a blank note as null', async () => {
      const { error } = await resolveComment(ownerClient, {
        p_comment_id: cp2,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: '   ',
      });
      expect(error).toBeNull();
      const row = await readLedgerRow(cp2);
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolution_note).toBeNull();
    });

    it('rejects a 501-char note with invalid_payload', async () => {
      const { error } = await resolveComment(ownerClient, {
        p_comment_id: cp3,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: 'x'.repeat(501),
      });
      expect(error?.message).toBe('invalid_payload');
      const row = await readLedgerRow(cp3);
      expect(row.resolved_at).toBeNull();
    });
  });

  describe('comment_edit on checkpoints and normal comments', () => {
    let editPostId: string;
    let checkpointId: string;

    beforeAll(async () => {
      editPostId = await insertPost('review');
      const { data, error } = await batchCreate(clientClient, {
        p_workspace_id: wsA.id,
        p_post_id: editPostId,
        p_points: [{ body: 'edit target' }],
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();
      checkpointId = asRefs(data)[0]!.id;
    });

    it('editing a checkpoint clears resolved_at, resolved_by and resolution_note', async () => {
      const resolved = await resolveComment(ownerClient, {
        p_comment_id: checkpointId,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: 'done in v3',
      });
      expect(resolved.error).toBeNull();

      const edited = await editComment(
        clientClient,
        { commentId: checkpointId, body: 'edit target, now sharper' },
        generateTraceId(),
      );
      expect(edited.ok).toBe(true);

      const row = await readLedgerRow(checkpointId);
      expect(row.body).toBe('edit target, now sharper');
      expect(row.edited_at).not.toBeNull();
      expect(row.resolved_at).toBeNull();
      expect(row.resolved_by).toBeNull();
      expect(row.resolution_note).toBeNull();
      expect(row.ledger_seq).toBe(1);
    });

    it('rejects a 51-word checkpoint edit with invalid_payload', async () => {
      const result = await editComment(
        clientClient,
        { commentId: checkpointId, body: words(51) },
        generateTraceId(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_payload');
      const row = await readLedgerRow(checkpointId);
      expect(row.body).toBe('edit target, now sharper');
    });

    it('leaves normal-comment edits unchanged: no word cap, resolved state untouched', async () => {
      // Authored by the owner: clients can no longer open a top-level post
      // comment (comment_create raises forbidden_role), and a resolvable
      // comment must be top-level, so this normal comment is owner-authored and
      // owner-edited. The assertion is about edit semantics, not the actor.
      const created = await createComment(ownerClient, {
        workspace_id: wsA.id,
        entity_type: 'post',
        entity_id: editPostId,
        body: 'a normal comment',
        trace_id: generateTraceId(),
      });
      if (!created.ok) throw new Error(`createComment failed: ${created.error.code}`);
      const normalId = created.data;

      const resolved = await resolveComment(ownerClient, {
        p_comment_id: normalId,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: 'keep me',
      });
      expect(resolved.error).toBeNull();

      const edited = await editComment(
        ownerClient,
        { commentId: normalId, body: words(60) },
        generateTraceId(),
      );
      expect(edited.ok).toBe(true);

      const row = await readLedgerRow(normalId);
      expect(row.body).toBe(words(60));
      expect(row.ledger_seq).toBeNull();
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_by).toBe(owner.id);
      expect(row.resolution_note).toBe('keep me');
    });
  });
});
