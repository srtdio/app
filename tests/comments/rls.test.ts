// Cross-tenant isolation for the comments read + create layer. A user who is an
// active member of workspace B must not be able to read or write comments in
// workspace A: RLS yields zero rows on reads, and the comment_create proc raises
// workspace_member_only on writes.

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
} from '../../packages/comments/src/index';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';

describe.runIf(COMMENTS_SUITE)('comments cross-tenant isolation', () => {
  let admin: SupabaseClient<Database>;
  let ownerA: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let ownerB: SeededUser;
  let wsB: SeededWorkspace;
  let intruder: Client;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    ownerA = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, ownerA, `Iso A ${ownerA.email}`);
    ctxA = await seedScaffold(admin, wsA);

    // A distinctive body so a positive search would have something to find.
    await insertRow(asGeneric(admin), 'comments', {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      author_user_id: ownerA.id,
      body: 'confidential zebra directive',
    });

    ownerB = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, ownerB, `Iso B ${ownerB.email}`);
    await seedScaffold(admin, wsB);
    intruder = clientFor(ownerB.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [ownerA, ownerB]);
  });

  it('listComments returns no rows from another workspace', async () => {
    const result = await listComments(intruder, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(0);
  });

  it('searchComments returns no rows from another workspace', async () => {
    const result = await searchComments(intruder, { workspace_id: wsA.id, query: 'zebra' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(0);
  });

  it('createComment into another workspace is rejected as workspace_member_only', async () => {
    const result = await createComment(intruder, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      body: 'intruder note',
      trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('workspace_member_only');
  });
});
