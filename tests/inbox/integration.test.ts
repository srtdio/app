// Integration coverage: each EVENT MAP trigger, driven through the worker's
// processEvent against the live local stack, asserted against inbox_entries
// ground truth. Each test seeds its own workspace, so a simple
// (workspace_id, event_type) filter isolates its writes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  cleanupWorkspaces,
  createAdminClient,
  loadRlsEnv,
  seedUser,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import { processEvent } from '../../workers/inbox-writer/src/process';
import type {
  AssetRow,
  AssetVersionRow,
  BriefRow,
  CommentRow,
  PostRow,
  WorkspaceMemberRow,
} from '../../packages/inbox/src/index';
import {
  entriesFor,
  inMemoryKv,
  insertFull,
  makeDeps,
  recipientsFor,
  seedInboxWorkspace,
  type InboxWorkspace,
} from './helpers';

const INBOX_SUITE = process.env.INBOX_SUITE === '1';

describe.runIf(INBOX_SUITE)('inbox-writer processEvent (integration)', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];

  async function freshWorkspace(): Promise<InboxWorkspace> {
    const ws = await seedInboxWorkspace(env, admin);
    workspaces.push({ id: ws.workspaceId, name: 'Inbox', ownerId: ws.owner.id });
    users.push(...ws.users);
    return ws;
  }

  function deps() {
    return makeDeps(env, admin, inMemoryKv());
  }

  async function insertPost(ws: InboxWorkspace, stage = 'review'): Promise<PostRow> {
    return insertFull<PostRow>(admin, 'posts', {
      workspace_id: ws.workspaceId,
      title: 'Post',
      bucket_id: ws.bucketId,
      owner_user_id: ws.owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: ws.owner.id,
      stage,
    });
  }

  async function insertComment(
    ws: InboxWorkspace,
    over: Record<string, unknown>,
  ): Promise<CommentRow> {
    return insertFull<CommentRow>(admin, 'comments', {
      workspace_id: ws.workspaceId,
      entity_type: 'post',
      body: 'hi',
      ...over,
    });
  }

  beforeAll(() => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  it('comment INSERT on a post: owner + prior authors + validated mention; mention is urgent', async () => {
    const ws = await freshWorkspace();
    const post = await insertPost(ws);
    await insertComment(ws, { entity_id: post.id, author_user_id: ws.agency.id });
    const fresh = await insertComment(ws, {
      entity_id: post.id,
      author_user_id: ws.client.id,
      mentions: [ws.admin.id, '00000000-0000-0000-0000-0000deadbeef'],
    });

    await processEvent({ table: 'comments', type: 'INSERT', row: fresh }, deps());

    expect(await recipientsFor(admin, ws.workspaceId, 'comment')).toEqual(
      new Set([ws.owner.id, ws.agency.id, ws.admin.id]),
    );
    const mentions = await entriesFor(admin, ws.workspaceId, 'mention');
    expect(new Set(mentions.map((m) => m.user_id))).toEqual(new Set([ws.admin.id]));
    expect(mentions.every((m) => m.tier === 'urgent')).toBe(true);
  });

  it('comment INSERT on a brief: creator + agency roles, minus author', async () => {
    const ws = await freshWorkspace();
    const brief = await insertFull<BriefRow>(admin, 'briefs', {
      workspace_id: ws.workspaceId,
      title: 'B',
      objective: 'O',
      created_by: ws.owner.id,
    });
    const fresh = await insertComment(ws, {
      entity_type: 'brief',
      entity_id: brief.id,
      author_user_id: ws.client.id,
    });

    await processEvent({ table: 'comments', type: 'INSERT', row: fresh }, deps());

    expect(await recipientsFor(admin, ws.workspaceId, 'comment')).toEqual(
      new Set([ws.owner.id, ws.admin.id, ws.agency.id]),
    );
  });

  it('post stage change to approved is urgent, to owner + admins', async () => {
    const ws = await freshWorkspace();
    const post = await insertPost(ws, 'review');
    const row: PostRow = { ...post, stage: 'approved' };

    await processEvent({ table: 'posts', type: 'UPDATE', row, old: { stage: 'review' } }, deps());

    const rows = await entriesFor(admin, ws.workspaceId, 'stage_change');
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([ws.owner.id, ws.admin.id]));
    expect(rows.every((r) => r.tier === 'urgent')).toBe(true);
  });

  it('post stage change to review is active', async () => {
    const ws = await freshWorkspace();
    const post = await insertPost(ws, 'draft');
    const row: PostRow = { ...post, stage: 'review' };

    await processEvent({ table: 'posts', type: 'UPDATE', row, old: { stage: 'draft' } }, deps());

    const rows = await entriesFor(admin, ws.workspaceId, 'stage_change');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tier === 'active')).toBe(true);
  });

  it('comment resolved_at flip emits comment_resolved to audience minus author', async () => {
    const ws = await freshWorkspace();
    const post = await insertPost(ws);
    await insertComment(ws, { entity_id: post.id, author_user_id: ws.client.id });
    const resolved = await insertComment(ws, {
      entity_id: post.id,
      author_user_id: ws.agency.id,
      resolved_at: new Date().toISOString(),
      resolved_by: ws.agency.id,
    });

    await processEvent(
      { table: 'comments', type: 'UPDATE', row: resolved, old: { resolved_at: null } },
      deps(),
    );

    expect(await recipientsFor(admin, ws.workspaceId, 'comment_resolved')).toEqual(
      new Set([ws.owner.id, ws.client.id]),
    );
  });

  it('brief INSERT notifies agency/admin/owner', async () => {
    const ws = await freshWorkspace();
    const brief = await insertFull<BriefRow>(admin, 'briefs', {
      workspace_id: ws.workspaceId,
      title: 'B',
      objective: 'O',
      created_by: ws.client.id,
    });

    await processEvent({ table: 'briefs', type: 'INSERT', row: brief }, deps());

    expect(await recipientsFor(admin, ws.workspaceId, 'brief_created')).toEqual(
      new Set([ws.owner.id, ws.admin.id, ws.agency.id]),
    );
  });

  it('brief close notifies agency/admin/owner + created_by', async () => {
    const ws = await freshWorkspace();
    const brief = await insertFull<BriefRow>(admin, 'briefs', {
      workspace_id: ws.workspaceId,
      title: 'B',
      objective: 'O',
      created_by: ws.client.id,
      status: 'closed',
      closed_at: new Date().toISOString(),
      closed_by: ws.owner.id,
    });

    await processEvent(
      { table: 'briefs', type: 'UPDATE', row: brief, old: { status: 'open' } },
      deps(),
    );

    expect(await recipientsFor(admin, ws.workspaceId, 'brief_closed')).toEqual(
      new Set([ws.owner.id, ws.admin.id, ws.agency.id, ws.client.id]),
    );
  });

  it('asset INSERT notifies agency/admin/owner', async () => {
    const ws = await freshWorkspace();
    const asset = await insertFull<AssetRow>(admin, 'assets', {
      workspace_id: ws.workspaceId,
      filename: 'f.png',
      uploaded_by: ws.agency.id,
    });

    await processEvent({ table: 'assets', type: 'INSERT', row: asset }, deps());

    expect(await recipientsFor(admin, ws.workspaceId, 'asset_uploaded')).toEqual(
      new Set([ws.owner.id, ws.admin.id, ws.agency.id]),
    );
  });

  it('asset_version INSERT > 1 notifies agency/admin/owner; v1 does nothing', async () => {
    const ws = await freshWorkspace();
    const asset = await insertFull<AssetRow>(admin, 'assets', {
      workspace_id: ws.workspaceId,
      filename: 'f.png',
      uploaded_by: ws.agency.id,
    });
    const mkVersion = (n: number) =>
      insertFull<AssetVersionRow>(admin, 'asset_versions', {
        asset_id: asset.id,
        workspace_id: ws.workspaceId,
        version_number: n,
        kind: 'image',
        r2_key: `k/${n}/${crypto.randomUUID()}`,
        mime_type: 'image/png',
        sha256: 'a'.repeat(64),
        size_bytes: 1,
        uploaded_by: ws.agency.id,
      });

    await processEvent(
      { table: 'asset_versions', type: 'INSERT', row: await mkVersion(1) },
      deps(),
    );
    expect((await entriesFor(admin, ws.workspaceId, 'asset_version_added')).length).toBe(0);

    await processEvent(
      { table: 'asset_versions', type: 'INSERT', row: await mkVersion(2) },
      deps(),
    );
    expect(await recipientsFor(admin, ws.workspaceId, 'asset_version_added')).toEqual(
      new Set([ws.owner.id, ws.admin.id, ws.agency.id]),
    );
  });

  it('pending workspace_members INSERT emits an urgent invite to the invitee', async () => {
    const ws = await freshWorkspace();
    const invitee = await seedUser(env, admin);
    users.push(invitee);
    const member = await insertFull<WorkspaceMemberRow>(admin, 'workspace_members', {
      workspace_id: ws.workspaceId,
      user_id: invitee.id,
      role: 'client',
      active: false,
    });

    await processEvent({ table: 'workspace_members', type: 'INSERT', row: member }, deps());

    const rows = await entriesFor(admin, ws.workspaceId, 'invite');
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([invitee.id]));
    expect(rows.every((r) => r.tier === 'urgent')).toBe(true);
  });
});
