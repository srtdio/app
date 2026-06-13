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
  annotationCreate,
  briefClose,
  briefCreate,
  commentCreate,
  memberAccept,
  memberInvite,
  postVersionCreate,
  stageTransition,
  workspaceCreate,
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

  // Workspaces created by workspace_create, tracked so teardown can delete them.
  const createdWorkspaces: SeededWorkspace[] = [];

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

  // Activity (inbox) events are now emitted inline by the procs. Each proc-driven
  // test seeds its own post / comment, so a (workspace_id, event_type, entity_id)
  // filter isolates that one call's writes from the shared workspace's history.
  async function inboxRecipients(
    workspaceId: string,
    eventType: string,
    entityId: string,
  ): Promise<Set<string>> {
    const res = await asGeneric(admin)
      .from('inbox_entries')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('event_type', eventType)
      .eq('entity_id', entityId);
    const rows = res.data as Array<{ user_id: string }> | null;
    return new Set((rows ?? []).map((r) => r.user_id));
  }

  // Active members of a workspace minus the actor. wsA accumulates members as
  // the suite runs (e.g. the accepted invite), so stage_change fanout is checked
  // against this ground truth rather than a hardcoded membership.
  async function activeMemberIdsExcept(workspaceId: string, exclude: string): Promise<Set<string>> {
    const res = await asGeneric(admin)
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('active', true);
    const rows = res.data as Array<{ user_id: string }> | null;
    return new Set((rows ?? []).map((r) => r.user_id).filter((id) => id !== exclude));
  }

  interface AttachmentRow {
    asset_id: string;
    asset_version_id: string;
    position: number;
    workspace_id: string;
    entity_type: string;
  }

  async function commentAttachments(commentId: string): Promise<AttachmentRow[]> {
    const res = await asGeneric(admin)
      .from('asset_attachments')
      .select('asset_id,asset_version_id,position,workspace_id,entity_type')
      .eq('entity_type', 'comment')
      .eq('entity_id', commentId);
    return (res.data as AttachmentRow[] | null) ?? [];
  }

  // An asset with a pinned current version, so it satisfies comment_create's
  // attachment guard (current_version_id IS NOT NULL, same workspace, live).
  async function seedAssetWithVersion(
    workspaceId: string,
    uploadedBy: string,
  ): Promise<{ assetId: string; versionId: string }> {
    const asset = await insertRow(asGeneric(admin), 'assets', {
      workspace_id: workspaceId,
      filename: 'attach.png',
      uploaded_by: uploadedBy,
    });
    const version = await insertRow(asGeneric(admin), 'asset_versions', {
      asset_id: asset.id,
      workspace_id: workspaceId,
      version_number: 1,
      kind: 'image',
      r2_key: `k/${crypto.randomUUID()}`,
      mime_type: 'image/png',
      sha256: randomSha256(),
      size_bytes: 1,
      uploaded_by: uploadedBy,
    });
    await asGeneric(admin)
      .from('assets')
      .update({ current_version_id: version.id })
      .eq('id', String(asset.id));
    return { assetId: String(asset.id), versionId: String(version.id) };
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
      [wsA, wsB, ...createdWorkspaces],
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

    it('workspace_create: a user creates a workspace', async () => {
      const id = expectOk(
        await workspaceCreate(ownerClient, {
          p_payload: { name: 'Fresh workspace', timezone: 'UTC' },
          p_trace_id: generateTraceId(),
        }),
      );
      expect(typeof id).toBe('string');
      createdWorkspaces.push({ id, name: 'Fresh workspace', ownerId: owner.id });
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

  // -------------------------------------------------------------------------
  // workspace_create payload guard: a malformed payload is rejected
  // -------------------------------------------------------------------------
  describe('workspace_create guards', () => {
    it('rejects a payload missing required keys (invalid_payload)', async () => {
      const result = await workspaceCreate(ownerClient, {
        p_payload: { name: 'Missing timezone' },
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('invalid_payload');
    });
  });

  // -------------------------------------------------------------------------
  // B-activity: comment attachments land in Assets, one-level threading is
  // enforced, and comment / mention / stage_change Activity events fire inline.
  // -------------------------------------------------------------------------
  describe('comment attachments + activity side-effects', () => {
    it('comment_create pins each attachment to the asset current version (entity_type=comment)', async () => {
      const a1 = await seedAssetWithVersion(wsA.id, owner.id);
      const a2 = await seedAssetWithVersion(wsA.id, owner.id);
      const commentId = expectOk(
        await commentCreate(ownerClient, {
          p_workspace_id: wsA.id,
          p_entity_type: 'post',
          p_entity_id: ctxA.postId,
          p_parent_comment_id: null as unknown as string,
          p_body: 'see the attached refs',
          p_mentions: null,
          p_attachment_asset_ids: [a1.assetId, a2.assetId],
          p_is_decision: false,
          p_trace_id: generateTraceId(),
        }),
      );
      const rows = await commentAttachments(commentId);
      expect(rows.length).toBe(2);
      const byAsset = new Map(rows.map((r) => [r.asset_id, r]));
      expect(byAsset.get(a1.assetId)?.asset_version_id).toBe(a1.versionId);
      expect(byAsset.get(a2.assetId)?.asset_version_id).toBe(a2.versionId);
      for (const r of rows) {
        expect(r.entity_type).toBe('comment');
        expect(r.workspace_id).toBe(wsA.id);
      }
      expect(new Set(rows.map((r) => r.position))).toEqual(new Set([0, 1]));
    });

    it('comment_create rejects an attachment with no current version (invalid_payload)', async () => {
      const asset = await insertRow(asGeneric(admin), 'assets', {
        workspace_id: wsA.id,
        filename: 'no-version.png',
        uploaded_by: owner.id,
      });
      const result = await commentCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: ctxA.postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'attaching an asset with no version',
        p_mentions: null,
        p_attachment_asset_ids: [String(asset.id)],
        p_is_decision: false,
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('invalid_payload');
    });

    it('comment_create rejects an attachment from another workspace (invalid_payload)', async () => {
      const foreign = await seedAssetWithVersion(wsB.id, ownerB.id);
      const result = await commentCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: ctxA.postId,
        p_parent_comment_id: null as unknown as string,
        p_body: 'cross-tenant attachment',
        p_mentions: null,
        p_attachment_asset_ids: [foreign.assetId],
        p_is_decision: false,
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('invalid_payload');
    });

    it('comment_create rejects a reply to an already-threaded comment (one level only)', async () => {
      const child = expectOk(
        await commentCreate(ownerClient, {
          p_workspace_id: wsA.id,
          p_entity_type: 'post',
          p_entity_id: ctxA.postId,
          p_parent_comment_id: ctxA.commentId,
          p_body: 'first-level reply',
          p_mentions: null,
          p_attachment_asset_ids: [],
          p_is_decision: false,
          p_trace_id: generateTraceId(),
        }),
      );
      const result = await commentCreate(ownerClient, {
        p_workspace_id: wsA.id,
        p_entity_type: 'post',
        p_entity_id: ctxA.postId,
        p_parent_comment_id: child,
        p_body: 'reply to a reply',
        p_mentions: null,
        p_attachment_asset_ids: [],
        p_is_decision: false,
        p_trace_id: generateTraceId(),
      });
      expect(expectError(result).code).toBe('invalid_payload');
    });

    it('a comment on a draft post notifies active members but isolates the client role', async () => {
      const postId = await insertPost(ctxA, 'draft');
      expectOk(
        await commentCreate(ownerClient, {
          p_workspace_id: wsA.id,
          p_entity_type: 'post',
          p_entity_id: postId,
          p_parent_comment_id: null as unknown as string,
          p_body: 'note on a draft',
          p_mentions: null,
          p_attachment_asset_ids: [],
          p_is_decision: false,
          p_trace_id: generateTraceId(),
        }),
      );
      const recipients = await inboxRecipients(wsA.id, 'comment', postId);
      expect(recipients.has(agencyUser.id)).toBe(true); // active agency member is notified
      expect(recipients.has(owner.id)).toBe(false); // the actor never notifies itself
      expect(recipients.has(clientUser.id)).toBe(false); // draft isolation: client is excluded
    });

    it('a mention notifies the mentioned active member', async () => {
      const postId = await insertPost(ctxA, 'review');
      expectOk(
        await commentCreate(ownerClient, {
          p_workspace_id: wsA.id,
          p_entity_type: 'post',
          p_entity_id: postId,
          p_parent_comment_id: null as unknown as string,
          p_body: 'pinging the team',
          p_mentions: [agencyUser.id],
          p_attachment_asset_ids: [],
          p_is_decision: false,
          p_trace_id: generateTraceId(),
        }),
      );
      expect(await inboxRecipients(wsA.id, 'mention', postId)).toEqual(new Set([agencyUser.id]));
    });

    it('stage_transition notifies every active member except the actor', async () => {
      const postId = await insertPost(ctxA, 'draft');
      expectOk(
        await stageTransition(ownerClient, {
          p_post_id: postId,
          p_to_stage: 'review',
          p_trace_id: generateTraceId(),
        }),
      );
      const recipients = await inboxRecipients(wsA.id, 'stage_change', postId);
      expect(recipients).toEqual(await activeMemberIdsExcept(wsA.id, owner.id));
      expect(recipients.has(owner.id)).toBe(false); // the actor never notifies itself
      expect(recipients.has(agencyUser.id)).toBe(true);
      expect(recipients.has(clientUser.id)).toBe(true);
    });
  });
});
