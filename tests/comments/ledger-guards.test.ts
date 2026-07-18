// Boundary coverage for the feedback-ledger edit/mentions/version migration
// (20260717150000_feedback_ledger_edit_mentions_version.sql), mirroring
// tests/comments/ledger.test.ts: fixtures are seeded through the service-role
// admin client only, every proc under test runs as the AUTHENTICATED role, and
// p_trace_id is always a fresh uuid_v7 passed explicitly. The actor is whatever
// auth.uid() the calling client carries; no caller-supplied user id is ever
// passed to a proc. comment_batch_create, comment_resolve and post_ready_notify
// have no @srtdio/rpc wrapper, so they are invoked through the typed `.rpc()`
// surface directly. resolved_version_id is read back through the generic
// (untyped) admin client because the generated types predate the column.

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
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';

type Db = SupabaseClient<Database>;
type Functions = Database['public']['Functions'];
type BatchCreateArgs = Functions['comment_batch_create']['Args'];
type CreateArgs = Functions['comment_create']['Args'];
type EditArgs = Functions['comment_edit']['Args'];
type ResolveArgs = Functions['comment_resolve']['Args'];
type SoftDeleteArgs = Functions['comment_soft_delete']['Args'];
type ReadyArgs = Functions['post_ready_notify']['Args'];

interface CheckpointRef {
  id: string;
  seq: number;
}

/** Ledger + resolution columns of a comments row, read via the generic client. */
interface GuardRow {
  body: string;
  ledger_seq: number | null;
  deleted_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_version_id: string | null;
}

function batchCreate(client: Db, args: BatchCreateArgs) {
  return client.rpc('comment_batch_create', args);
}
function commentCreate(client: Db, args: CreateArgs) {
  return client.rpc('comment_create', args);
}
function commentEdit(client: Db, args: EditArgs) {
  return client.rpc('comment_edit', args);
}
function resolveComment(client: Db, args: ResolveArgs) {
  return client.rpc('comment_resolve', args);
}
function softDelete(client: Db, args: SoftDeleteArgs) {
  return client.rpc('comment_soft_delete', args);
}
function postReadyNotify(client: Db, args: ReadyArgs) {
  return client.rpc('post_ready_notify', args);
}

/** A body of exactly n whitespace-separated words. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');
}

function asRefs(data: unknown): CheckpointRef[] {
  if (!Array.isArray(data)) throw new Error('expected a jsonb array of {id, seq}');
  return data as CheckpointRef[];
}

/** A single-point batch as this client, returning the new checkpoint id. */
async function seedCheckpoint(
  client: Db,
  wsId: string,
  postId: string,
  body = 'checkpoint',
): Promise<string> {
  const { data, error } = await batchCreate(client, {
    p_workspace_id: wsId,
    p_post_id: postId,
    p_points: [{ body }] as unknown as BatchCreateArgs['p_points'],
    p_trace_id: generateTraceId(),
  });
  if (error) throw new Error(`batchCreate failed: ${error.message}`);
  return asRefs(data)[0]!.id;
}

describe.runIf(COMMENTS_SUITE)('feedback ledger guards (edit / mentions / version)', () => {
  let admin: Db;
  let owner: SeededUser;
  let clientA: SeededUser;
  let clientB: SeededUser;
  let agency: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let ownerClient: Db;
  let clientAClient: Db;
  let agencyClient: Db;

  async function insertPost(stage: string): Promise<string> {
    const g = asGeneric(admin);
    const row = await insertRow(g, 'posts', {
      workspace_id: wsA.id,
      number: await nextEntityNumber(g, wsA.id),
      title: 'Guard post',
      bucket_id: ctxA.bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: owner.id,
      stage,
    });
    return String(row.id);
  }

  /** Insert one post_versions row and return its id. */
  async function insertVersion(postId: string, versionNumber: number): Promise<string> {
    const row = await insertRow(asGeneric(admin), 'post_versions', {
      post_id: postId,
      workspace_id: wsA.id,
      version_number: versionNumber,
      snapshot: {},
      created_by: owner.id,
    });
    return String(row.id);
  }

  async function addMember(user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: wsA.id,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  async function readRow(id: string): Promise<GuardRow> {
    const res = await asGeneric(admin)
      .from('comments')
      .select(
        'body, ledger_seq, deleted_at, resolved_at, resolved_by, resolution_note, resolved_version_id',
      )
      .eq('id', id);
    if (res.error) throw new Error(`comments read failed: ${res.error.message}`);
    const first = (res.data as GuardRow[] | null)?.[0];
    if (!first) throw new Error(`comment ${id} not found`);
    return first;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Guards ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);
    ownerClient = clientFor(owner.id);

    clientA = await seedUser(env, admin);
    await addMember(clientA, 'client');
    clientAClient = clientFor(clientA.id);

    clientB = await seedUser(env, admin);
    await addMember(clientB, 'client');

    agency = await seedUser(env, admin);
    await addMember(agency, 'agency');
    agencyClient = clientFor(agency.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA], [owner, clientA, clientB, agency]);
  });

  // 1 -----------------------------------------------------------------------
  describe('comment_batch_create word cap boundary', () => {
    it('accepts a 50-word ask', async () => {
      const postId = await insertPost('review');
      const { data, error } = await batchCreate(clientAClient, {
        p_workspace_id: wsA.id,
        p_post_id: postId,
        p_points: [{ body: words(50) }] as unknown as BatchCreateArgs['p_points'],
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();
      expect(asRefs(data)).toHaveLength(1);
      expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', postId]])).toBe(1);
    });

    it('rejects a 51-word ask with invalid_payload and writes no comment rows', async () => {
      const postId = await insertPost('review');
      const { error } = await batchCreate(clientAClient, {
        p_workspace_id: wsA.id,
        p_post_id: postId,
        p_points: [{ body: words(51) }] as unknown as BatchCreateArgs['p_points'],
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('invalid_payload');
      expect(await countWhere(asGeneric(admin), 'comments', [['entity_id', postId]])).toBe(0);
    });
  });

  // 2 -----------------------------------------------------------------------
  it('routes a mentioned member to an urgent mention and off the checkpoints fan-out', async () => {
    const postId = await insertPost('review');
    const { error } = await batchCreate(clientAClient, {
      p_workspace_id: wsA.id,
      p_post_id: postId,
      p_points: [
        { body: 'ping the agency', mentions: [agency.id] },
      ] as unknown as BatchCreateArgs['p_points'],
      p_trace_id: generateTraceId(),
    });
    expect(error).toBeNull();

    // The mentioned member: one urgent 'mention', zero 'checkpoints_added'.
    expect(
      await countWhere(asGeneric(admin), 'inbox_entries', [
        ['event_type', 'mention'],
        ['entity_id', postId],
        ['user_id', agency.id],
        ['tier', 'urgent'],
      ]),
    ).toBe(1);
    expect(
      await countWhere(asGeneric(admin), 'inbox_entries', [
        ['event_type', 'checkpoints_added'],
        ['entity_id', postId],
        ['user_id', agency.id],
      ]),
    ).toBe(0);

    // A non-mentioned active member: 'checkpoints_added' only, no mention.
    expect(
      await countWhere(asGeneric(admin), 'inbox_entries', [
        ['event_type', 'checkpoints_added'],
        ['entity_id', postId],
        ['user_id', owner.id],
      ]),
    ).toBe(1);
    expect(
      await countWhere(asGeneric(admin), 'inbox_entries', [
        ['event_type', 'mention'],
        ['entity_id', postId],
        ['user_id', owner.id],
      ]),
    ).toBe(0);
  });

  // 3 -----------------------------------------------------------------------
  describe('comment_create client top-level post guard', () => {
    it('rejects a client top-level post comment with forbidden_role', async () => {
      const postId = await insertPost('review');
      const { error } = await commentCreate(clientAClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'client top-level',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('forbidden_role');
    });

    it('lets the same client reply under a parent post comment', async () => {
      const postId = await insertPost('review');
      const parent = await commentCreate(agencyClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'agency thread root',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(parent.error).toBeNull();

      const reply = await commentCreate(clientAClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: String(parent.data),
        p_body: 'client reply',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(reply.error).toBeNull();
      expect(reply.data).toBeTruthy();
    });

    it('lets an agency member create a top-level post comment', async () => {
      const postId = await insertPost('review');
      const { data, error } = await commentCreate(agencyClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'agency top-level',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
    });

    it('lets a client create a top-level brief comment', async () => {
      const { data, error } = await commentCreate(clientAClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'brief',
        p_entity_id: ctxA.briefId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'client brief note',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
    });
  });

  // 4 -----------------------------------------------------------------------
  describe('comment_edit', () => {
    it('rejects a non-author with forbidden_role', async () => {
      const postId = await insertPost('review');
      const created = await commentCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'owner comment',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(created.error).toBeNull();
      const { error } = await commentEdit(clientAClient, {
        p_comment_id: String(created.data),
        p_body: 'not my comment',
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('forbidden_role');
    });

    it('rejects a 51-word checkpoint edit with invalid_payload', async () => {
      const postId = await insertPost('review');
      const cp = await seedCheckpoint(clientAClient, wsA.id, postId, 'edit target');
      const { error } = await commentEdit(clientAClient, {
        p_comment_id: cp,
        p_body: words(51),
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('invalid_payload');
      expect((await readRow(cp)).body).toBe('edit target');
    });

    it('clears every resolution column, including resolved_version_id, on a checkpoint edit', async () => {
      const postId = await insertPost('review');
      const versionId = await insertVersion(postId, 1);
      const cp = await seedCheckpoint(clientAClient, wsA.id, postId, 'resolve then edit');

      const resolved = await resolveComment(ownerClient, {
        p_comment_id: cp,
        p_resolved: true,
        p_trace_id: generateTraceId(),
        p_resolution_note: 'done in v1',
      });
      expect(resolved.error).toBeNull();
      let row = await readRow(cp);
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_version_id).toBe(versionId);

      const edited = await commentEdit(clientAClient, {
        p_comment_id: cp,
        p_body: 'resolve then edit, sharper',
        p_trace_id: generateTraceId(),
      });
      expect(edited.error).toBeNull();
      row = await readRow(cp);
      expect(row.body).toBe('resolve then edit, sharper');
      expect(row.resolved_at).toBeNull();
      expect(row.resolved_by).toBeNull();
      expect(row.resolution_note).toBeNull();
      expect(row.resolved_version_id).toBeNull();
    });
  });

  // 5 -----------------------------------------------------------------------
  describe('comment_soft_delete', () => {
    it('rejects a non-author with forbidden_role', async () => {
      const postId = await insertPost('review');
      const created = await commentCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'owner comment',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(created.error).toBeNull();
      const { error } = await softDelete(clientAClient, {
        p_comment_id: String(created.data),
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('forbidden_role');
    });

    it('lets the author soft-delete, setting deleted_at', async () => {
      const postId = await insertPost('review');
      const created = await commentCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'delete me',
        p_mentions: null as unknown as CreateArgs['p_mentions'],
        p_attachment_asset_ids: [],
        p_trace_id: generateTraceId(),
      });
      expect(created.error).toBeNull();
      const id = String(created.data);
      const { error } = await softDelete(ownerClient, {
        p_comment_id: id,
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();
      expect((await readRow(id)).deleted_at).not.toBeNull();
    });
  });

  // 6 -----------------------------------------------------------------------
  it('stamps resolved_version_id with the highest version and clears it on reopen', async () => {
    const postId = await insertPost('review');
    await insertVersion(postId, 1);
    const v2 = await insertVersion(postId, 2);
    const cp = await seedCheckpoint(clientAClient, wsA.id, postId, 'version target');

    const resolved = await resolveComment(ownerClient, {
      p_comment_id: cp,
      p_resolved: true,
      p_trace_id: generateTraceId(),
    });
    expect(resolved.error).toBeNull();
    expect((await readRow(cp)).resolved_version_id).toBe(v2);

    const reopened = await resolveComment(ownerClient, {
      p_comment_id: cp,
      p_resolved: false,
      p_trace_id: generateTraceId(),
    });
    expect(reopened.error).toBeNull();
    expect((await readRow(cp)).resolved_version_id).toBeNull();
  });

  // 7 -----------------------------------------------------------------------
  describe('post_ready_notify', () => {
    it('raises checkpoints_open while any ledger comment is unresolved', async () => {
      const postId = await insertPost('review');
      await seedCheckpoint(clientAClient, wsA.id, postId, 'still open');
      const { error } = await postReadyNotify(agencyClient, {
        p_post_id: postId,
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('checkpoints_open');
    });

    it('rejects a client caller with forbidden_role', async () => {
      const postId = await insertPost('review');
      const { error } = await postReadyNotify(clientAClient, {
        p_post_id: postId,
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('forbidden_role');
    });

    it('rejects a non-review post with invalid_stage', async () => {
      const postId = await insertPost('approved');
      const { error } = await postReadyNotify(agencyClient, {
        p_post_id: postId,
        p_trace_id: generateTraceId(),
      });
      expect(error?.message).toBe('invalid_stage');
    });

    it('notifies client members only when every checkpoint is resolved', async () => {
      const postId = await insertPost('review');
      const cp = await seedCheckpoint(clientAClient, wsA.id, postId, 'resolve me');
      const resolved = await resolveComment(ownerClient, {
        p_comment_id: cp,
        p_resolved: true,
        p_trace_id: generateTraceId(),
      });
      expect(resolved.error).toBeNull();

      const { error } = await postReadyNotify(agencyClient, {
        p_post_id: postId,
        p_trace_id: generateTraceId(),
      });
      expect(error).toBeNull();

      for (const client of [clientA, clientB]) {
        expect(
          await countWhere(asGeneric(admin), 'inbox_entries', [
            ['event_type', 'post_ready'],
            ['entity_id', postId],
            ['user_id', client.id],
          ]),
        ).toBe(1);
      }
      for (const nonClient of [owner, agency]) {
        expect(
          await countWhere(asGeneric(admin), 'inbox_entries', [
            ['event_type', 'post_ready'],
            ['entity_id', postId],
            ['user_id', nonClient.id],
          ]),
        ).toBe(0);
      }
    });
  });
});
