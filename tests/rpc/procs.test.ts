// E2E coverage for the SECURITY DEFINER write procs, exercised through the
// @srtdio/rpc wrappers as the AUTHENTICATED role (never service_role). The
// service-role admin client is used only to seed fixtures and to read back
// ground truth, mirroring the RLS suite's model (see packages/test-utils/rls.ts).
//
// Covered: a happy path per client-facing proc; every cell of the stage matrix
// (positive and negative); forbidden-role rejection (a client attempting an
// agency-only action); and cross-tenant rejection (a user in workspace B acting
// on workspace A). inbox_entry_create has no EXECUTE grant to authenticated and
// no wrapper, so it is not exercised here.

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
  annotationCreate,
  briefClose,
  briefCreate,
  commentCreate,
  memberAccept,
  memberInvite,
  postVersionCreate,
  stageTransition,
  type Client,
  type DomainError,
  type Result,
} from '../../packages/rpc/src/index';

const RPC_SUITE = process.env.RPC_SUITE === '1';

// --- the locked stage matrix, mirrored from the migration ------------------
const STAGES = ['draft', 'review', 'approved', 'parked', 'rejected'] as const;
const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['review', 'parked'],
  review: ['approved', 'rejected', 'parked'],
  approved: ['parked', 'rejected'],
  parked: ['review'],
  rejected: ['review'],
};

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

describe.runIf(RPC_SUITE)('SECURITY DEFINER write procs (authenticated role)', () => {
  let admin: SupabaseClient<Database>;

  // Workspace A and its members at every role we need.
  let owner: SeededUser;
  let agencyUser: SeededUser;
  let clientUser: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let ownerClient: Client;
  let agencyClient: Client;
  let clientClient: Client;
  let attachmentId: string;

  // Workspace B, for cross-tenant checks.
  let ownerB: SeededUser;
  let wsB: SeededWorkspace;

  // Users created by invite tests, tracked so teardown can delete them.
  const invitees: SeededUser[] = [];

  async function addMember(workspaceId: string, user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  async function insertPost(ctx: Ctx, stage: string): Promise<string> {
    const row = await insertRow(asGeneric(admin), 'posts', {
      workspace_id: ctx.workspaceId,
      title: 'Matrix post',
      bucket_id: ctx.bucketId,
      owner_user_id: ctx.userId,
      platform: 'linkedin',
      format: 'text',
      created_by: ctx.userId,
      stage,
    });
    return String(row.id);
  }

  async function insertOpenBrief(ctx: Ctx, createdBy: string): Promise<string> {
    const row = await insertRow(asGeneric(admin), 'briefs', {
      workspace_id: ctx.workspaceId,
      title: 'Brief',
      objective: 'Objective',
      created_by: createdBy,
    });
    return String(row.id);
  }

  async function readPostStage(postId: string): Promise<string | undefined> {
    const res = await asGeneric(admin).from('posts').select('stage').eq('id', postId);
    const rows = res.data as Array<{ stage: string }> | null;
    return rows?.[0]?.stage;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `RPC A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);

    agencyUser = await seedUser(env, admin);
    await addMember(wsA.id, agencyUser, 'agency');
    clientUser = await seedUser(env, admin);
    await addMember(wsA.id, clientUser, 'client');

    ownerClient = clientFor(owner.id);
    agencyClient = clientFor(agencyUser.id);
    clientClient = clientFor(clientUser.id);

    // A real attachment so annotation_create has a valid asset_attachment_id to
    // satisfy the generated (non-nullable) arg type.
    const att = await insertRow(asGeneric(admin), 'asset_attachments', {
      asset_id: ctxA.assetId,
      asset_version_id: ctxA.assetVersionId,
      entity_type: 'post',
      entity_id: ctxA.postId,
      workspace_id: ctxA.workspaceId,
      attached_by: ctxA.userId,
    });
    attachmentId = String(att.id);

    ownerB = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, ownerB, `RPC B ${ownerB.email}`);
    await seedScaffold(admin, wsB);
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [wsA, wsB],
      [owner, agencyUser, clientUser, ownerB, ...invitees],
    );
  });

  // -------------------------------------------------------------------------
  // Happy path per proc
  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('stage_transition: owner advances draft -> review', async () => {
      const postId = await insertPost(ctxA, 'draft');
      const id = expectOk(
        await stageTransition(ownerClient, {
          p_post_id: postId,
          p_to_stage: 'review',
          p_trace_id: generateTraceId(),
        }),
      );
      expect(id).toBe(postId);
      expect(await readPostStage(postId)).toBe('review');
    });

    it('post_version_create: appends an immutable version', async () => {
      const id = expectOk(
        await postVersionCreate(ownerClient, {
          p_post_id: ctxA.postId,
          p_snapshot: { title: 'snap' },
          p_trace_id: generateTraceId(),
        }),
      );
      expect(typeof id).toBe('string');
    });

    it('annotation_create: appends a caption_span marker', async () => {
      const id = expectOk(
        await annotationCreate(ownerClient, {
          p_post_id: ctxA.postId,
          p_post_version_id: ctxA.postVersionId,
          p_kind: 'caption_span',
          p_caption_start: 0,
          p_caption_end: 5,
          p_asset_attachment_id: attachmentId,
          p_image_x: 0,
          p_image_y: 0,
          p_comment_id: ctxA.commentId,
          p_trace_id: generateTraceId(),
        }),
      );
      expect(typeof id).toBe('string');
    });

    it('comment_create: any member can comment', async () => {
      const id = expectOk(
        await commentCreate(clientClient, {
          p_workspace_id: wsA.id,
          p_entity_type: 'post',
          p_entity_id: ctxA.postId,
          p_parent_comment_id: ctxA.commentId,
          p_body: 'looks good',
          p_mentions: null,
          p_attachment_asset_ids: [],
          p_is_decision: false,
          p_trace_id: generateTraceId(),
        }),
      );
      expect(typeof id).toBe('string');
    });

    it('brief_create: a client creates a brief', async () => {
      const id = expectOk(
        await briefCreate(clientClient, {
          p_workspace_id: wsA.id,
          p_payload: { title: 'New brief', objective: 'Do the thing' },
          p_trace_id: generateTraceId(),
        }),
      );
      expect(typeof id).toBe('string');
    });

    it('brief_close: owner closes an open brief', async () => {
      const briefId = await insertOpenBrief(ctxA, owner.id);
      expectOk(
        await briefClose(ownerClient, { p_brief_id: briefId, p_trace_id: generateTraceId() }),
      );
      const res = await asGeneric(admin).from('briefs').select('status').eq('id', briefId);
      const rows = res.data as Array<{ status: string }> | null;
      expect(rows?.[0]?.status).toBe('closed');
    });

    it('member_invite + member_accept: the full invite cycle', async () => {
      const env = loadRlsEnv();
      const invitee = await seedUser(env, admin);
      invitees.push(invitee);

      const memberId = expectOk(
        await memberInvite(ownerClient, {
          p_workspace_id: wsA.id,
          p_email: invitee.email,
          p_role: 'client',
          p_trace_id: generateTraceId(),
        }),
      );

      const accepted = expectOk(
        await memberAccept(clientFor(invitee.id), {
          p_invite_id: memberId,
          p_trace_id: generateTraceId(),
        }),
      );
      expect(accepted).toBe(memberId);

      const res = await asGeneric(admin)
        .from('workspace_members')
        .select('active')
        .eq('id', memberId);
      const rows = res.data as Array<{ active: boolean }> | null;
      expect(rows?.[0]?.active).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Full stage matrix: every (from, to) pair, positive and negative
  // -------------------------------------------------------------------------
  describe('stage matrix', () => {
    const cases: Array<[string, string, boolean]> = [];
    for (const from of STAGES) {
      for (const to of STAGES) {
        cases.push([from, to, (VALID_TRANSITIONS[from] ?? []).includes(to)]);
      }
    }

    it.each(cases)('%s -> %s', async (from, to, valid) => {
      const postId = await insertPost(ctxA, from);
      const result = await stageTransition(ownerClient, {
        p_post_id: postId,
        p_to_stage: to,
        p_trace_id: generateTraceId(),
      });
      if (valid) {
        expectOk(result);
        expect(await readPostStage(postId)).toBe(to);
      } else {
        expect(expectError(result).code).toBe('invalid_stage_transition');
        expect(await readPostStage(postId)).toBe(from);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Forbidden role: a client attempting agency-only actions
  // -------------------------------------------------------------------------
  describe('forbidden role', () => {
    it('client cannot drive a post draft -> review (needs post.edit)', async () => {
      const postId = await insertPost(ctxA, 'draft');
      const result = await stageTransition(clientClient, {
        p_post_id: postId,
        p_to_stage: 'review',
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('forbidden_role');
      expect(await readPostStage(postId)).toBe('draft');
    });

    it('owner cannot create a brief (brief.create is client-only)', async () => {
      const result = await briefCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_payload: { title: 'Nope', objective: 'Nope' },
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('forbidden_role');
    });

    it('agency cannot invite members (needs workspace.manage_members)', async () => {
      const result = await memberInvite(agencyClient, {
        p_workspace_id: wsA.id,
        p_email: 'someone@example.test',
        p_role: 'client',
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('forbidden_role');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant: a user in workspace B cannot act on workspace A
  // -------------------------------------------------------------------------
  describe('cross-tenant', () => {
    let bClient: Client;
    beforeAll(() => {
      bClient = clientFor(ownerB.id);
    });

    it('stage_transition against another workspace is workspace_member_only', async () => {
      const postId = await insertPost(ctxA, 'draft');
      const result = await stageTransition(bClient, {
        p_post_id: postId,
        p_to_stage: 'review',
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('workspace_member_only');
      expect(await readPostStage(postId)).toBe('draft');
    });

    it('comment_create against another workspace is workspace_member_only', async () => {
      const result = await commentCreate(bClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: ctxA.postId,
        p_parent_comment_id: ctxA.commentId,
        p_body: 'intruder',
        p_mentions: null,
        p_attachment_asset_ids: [],
        p_is_decision: false,
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('workspace_member_only');
    });

    it('brief_close against another workspace is workspace_member_only', async () => {
      const briefId = await insertOpenBrief(ctxA, owner.id);
      const result = await briefClose(bClient, {
        p_brief_id: briefId,
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('workspace_member_only');
    });
  });

  // -------------------------------------------------------------------------
  // member_accept state guard: only the invitee, and only once
  // -------------------------------------------------------------------------
  describe('member_accept guards', () => {
    it('a different user cannot accept an invite (forbidden_role)', async () => {
      const env = loadRlsEnv();
      const invitee = await seedUser(env, admin);
      invitees.push(invitee);
      const memberId = expectOk(
        await memberInvite(ownerClient, {
          p_workspace_id: wsA.id,
          p_email: invitee.email,
          p_role: 'client',
          p_trace_id: generateTraceId(),
        }),
      );
      const result = await memberAccept(clientClient, {
        p_invite_id: memberId,
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('forbidden_role');
    });
  });
});
