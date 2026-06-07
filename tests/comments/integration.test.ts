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
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
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
