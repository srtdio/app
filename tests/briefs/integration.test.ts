// End-to-end coverage for @srtdio/briefs against a local, ephemeral Supabase
// stack. Writes run as the AUTHENTICATED end user through the package wrappers
// (createBrief / closeBrief); reads run through listBriefs / getBrief, which are
// plain RLS-scoped SELECTs. The service-role admin client only seeds fixtures
// and reads ground truth, mirroring the RLS and RPC suites.
//
// Covered here: the create -> read -> close lifecycle, the opening comment, the
// per-request derived linked_posts_count (live posts only), the list filters,
// and the client-only create gate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  partitionTimestamp,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  closeBrief,
  createBrief,
  getBrief,
  listBriefs,
  type Client,
  type DomainError,
  type Result,
} from '../../packages/briefs/src/index';

const BRIEFS_SUITE = process.env.BRIEFS_SUITE === '1';

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

function expectError<T>(result: Result<T>): DomainError {
  if (result.ok) throw new Error('expected an error result, got ok');
  return result.error;
}

describe.runIf(BRIEFS_SUITE)('briefs read/write layer (authenticated role)', () => {
  let admin: SupabaseClient<Database>;

  let owner: SeededUser;
  let clientUser: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let ownerClient: Client;
  let clientClient: Client;

  let ownerB: SeededUser;
  let wsB: SeededWorkspace;

  async function addMember(workspaceId: string, user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  async function linkPost(briefId: string, deleted: boolean): Promise<string> {
    const row = await insertRow(asGeneric(admin), 'posts', {
      workspace_id: ctxA.workspaceId,
      title: 'Linked post',
      bucket_id: ctxA.bucketId,
      owner_user_id: ctxA.userId,
      platform: 'linkedin',
      format: 'text',
      created_by: ctxA.userId,
      brief_id: briefId,
      deleted_at: deleted ? partitionTimestamp : null,
    });
    return String(row.id);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Briefs A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);

    clientUser = await seedUser(env, admin);
    await addMember(wsA.id, clientUser, 'client');

    ownerClient = clientFor(owner.id);
    clientClient = clientFor(clientUser.id);

    ownerB = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, ownerB, `Briefs B ${ownerB.email}`);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner, clientUser, ownerB]);
  });

  it('create -> read: a client creates a brief and reads it back, count 0', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        {
          workspaceId: wsA.id,
          title: 'Launch teaser',
          objective: 'Tease the launch',
          formatRequested: 'carousel',
          targetDate: '2026-08-15',
        },
        generateTraceId(),
      ),
    );
    expect(typeof created.id).toBe('string');
    expect(created.commentId).toBeNull();

    const fetched = expectOk(await getBrief(clientClient, created.id));
    expect(fetched).not.toBeNull();
    expect(fetched?.brief.title).toBe('Launch teaser');
    expect(fetched?.brief.status).toBe('open');
    expect(fetched?.brief.created_via).toBe('app');
    expect(fetched?.linked_posts_count).toBe(0);
  });

  it('getBrief: linked_posts_count counts only live linked posts', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        { workspaceId: wsA.id, title: 'With posts', objective: 'Has linked posts' },
        generateTraceId(),
      ),
    );
    await linkPost(created.id, false);
    await linkPost(created.id, false);
    await linkPost(created.id, true); // soft-deleted: must not be counted

    const fetched = expectOk(await getBrief(ownerClient, created.id));
    expect(fetched?.linked_posts_count).toBe(2);
  });

  it('createBrief: initialCommentBody opens the brief comment thread', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        {
          workspaceId: wsA.id,
          title: 'Kick-off brief',
          objective: 'Start a thread',
          initialCommentBody: 'Here is the context',
        },
        generateTraceId(),
      ),
    );
    expect(typeof created.commentId).toBe('string');

    const res = await asGeneric(admin)
      .from('comments')
      .select('body,entity_type,entity_id')
      .eq('entity_id', created.id);
    const rows = res.data as Array<{ body: string; entity_type: string; entity_id: string }> | null;
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.entity_type).toBe('brief');
    expect(rows?.[0]?.body).toBe('Here is the context');
  });

  it('listBriefs: filters by status, creator, and target_date range', async () => {
    const inRange = expectOk(
      await createBrief(
        clientClient,
        { workspaceId: wsA.id, title: 'Dated brief', objective: 'O', targetDate: '2026-09-15' },
        generateTraceId(),
      ),
    );

    const open = expectOk(
      await listBriefs(clientClient, { status: 'open', createdBy: clientUser.id }),
    );
    expect(open.map((b) => b.id)).toContain(inRange.id);
    expect(open.every((b) => b.status === 'open')).toBe(true);
    expect(open.every((b) => b.created_by === clientUser.id)).toBe(true);

    const within = expectOk(
      await listBriefs(clientClient, {
        createdBy: clientUser.id,
        targetDateFrom: '2026-09-01',
        targetDateTo: '2026-09-30',
      }),
    );
    expect(within.map((b) => b.id)).toContain(inRange.id);

    const outside = expectOk(
      await listBriefs(clientClient, {
        createdBy: clientUser.id,
        targetDateFrom: '2026-10-01',
        targetDateTo: '2026-10-31',
      }),
    );
    expect(outside.map((b) => b.id)).not.toContain(inRange.id);
  });

  it('close: an agency owner closes an open brief, then re-close is rejected', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        { workspaceId: wsA.id, title: 'To close', objective: 'O' },
        generateTraceId(),
      ),
    );

    expectOk(await closeBrief(ownerClient, { briefId: created.id }, generateTraceId()));

    const fetched = expectOk(await getBrief(ownerClient, created.id));
    expect(fetched?.brief.status).toBe('closed');
    expect(fetched?.brief.closed_by).toBe(owner.id);

    const second = await closeBrief(ownerClient, { briefId: created.id }, generateTraceId());
    expect(expectError(second).code).toBe('invalid_payload');
  });

  it('create: the agency owner cannot create a brief (client-only)', async () => {
    const result = await createBrief(
      ownerClient,
      { workspaceId: wsA.id, title: 'Nope', objective: 'Nope' },
      generateTraceId(),
    );
    expect(expectError(result).code).toBe('forbidden_role');
  });

  it('close: a member of another workspace cannot close the brief', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        { workspaceId: wsA.id, title: 'Cross tenant', objective: 'O' },
        generateTraceId(),
      ),
    );
    const result = await closeBrief(
      clientFor(ownerB.id),
      { briefId: created.id },
      generateTraceId(),
    );
    expect(expectError(result).code).toBe('workspace_member_only');
  });
});
