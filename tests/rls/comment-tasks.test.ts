// Comment to task (20261108090100_comment_tasks.sql):
//
//   T1. An agency member in the chat calls comment_task_create: the task lands
//       in the chat, the comment_tasks link row is written and
//       comments.task_state is 'assigned'.
//   T2. The agency member reads the comment_tasks row; a client reads none.
//   T3. A client reads comments.task_state on the comment.
//   T4. A client cannot call comment_task_create ('not allowed').
//   T5. An agency member who is not in the target chat cannot ('not a member').
//   T6. Task done -> comments.task_state 'done'.
//   T7. Task deleted -> comments.task_state null and the link row is gone.
//
// Seeding goes through the service role (the privileged path), following the
// rationale in packages/test-utils/rls.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  seedMember,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type CreateArgs = Database['public']['Functions']['comment_task_create']['Args'];

function createArgs(commentId: string, channelId: string, title: string): CreateArgs {
  return {
    p_comment_id: commentId,
    p_channel_id: channelId,
    p_title: title,
    p_priority: 1,
    p_due_on: '2026-12-01',
    p_trace_id: generateTraceId(),
  };
}

describe.runIf(RLS_SUITE)('comment_tasks + comment_task_create', () => {
  let admin: Client;
  let owner: SeededUser;
  let outsiderAgency: SeededUser;
  let client: SeededUser;
  let ws: SeededWorkspace;
  let ctx: Ctx;
  let secondCommentId: string;
  let taskId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    const g = asGeneric(admin);
    owner = await seedUser(env, admin);
    outsiderAgency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Comment tasks ${owner.email}`);
    await seedMember(g, ws, outsiderAgency, 'agency');
    await seedMember(g, ws, client, 'client');
    // The scaffold seeds a post comment by the owner and a group chat whose only
    // member is the owner (outsiderAgency is not in it).
    ctx = await seedScaffold(admin, ws);
    // Clients only read posts out of draft.
    const staged = await admin.from('posts').update({ stage: 'review' }).eq('id', ctx.postId);
    expect(staged.error).toBeNull();
    const second = await insertRow(g, 'comments', {
      workspace_id: ws.id,
      entity_type: 'post',
      entity_id: ctx.postId,
      author_user_id: owner.id,
      body: 'second comment',
    });
    secondCommentId = String(second.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, outsiderAgency, client]);
  });

  it('T1: agency in the chat creates the task, link row and assigned state', async () => {
    const res = await clientFor(owner.id).rpc(
      'comment_task_create',
      createArgs(ctx.commentId, ctx.channelId, 'Fix the caption'),
    );
    expect(res.error).toBeNull();
    const out = res.data as { task_id?: string } | null;
    expect(typeof out?.task_id).toBe('string');
    taskId = String(out?.task_id);

    const task = await admin.from('chat_tasks').select('id, channel_id, title').eq('id', taskId);
    expect(task.error).toBeNull();
    expect(task.data).toHaveLength(1);
    expect(task.data?.[0]?.channel_id).toBe(ctx.channelId);
    expect(task.data?.[0]?.title).toBe('Fix the caption');

    const comment = await admin.from('comments').select('task_state').eq('id', ctx.commentId);
    expect(comment.data?.[0]?.task_state).toBe('assigned');
  });

  it('T2: agency reads the comment_tasks row; a client reads none', async () => {
    const agencyRead = await clientFor(owner.id)
      .from('comment_tasks')
      .select('comment_id, task_id, channel_id, group_name')
      .eq('comment_id', ctx.commentId);
    expect(agencyRead.error).toBeNull();
    expect(agencyRead.data).toHaveLength(1);
    expect(agencyRead.data?.[0]?.task_id).toBe(taskId);
    expect(agencyRead.data?.[0]?.group_name).not.toBeNull();

    const clientRead = await clientFor(client.id)
      .from('comment_tasks')
      .select('comment_id')
      .eq('comment_id', ctx.commentId);
    expect(clientRead.error).toBeNull();
    expect(clientRead.data).toHaveLength(0);
  });

  it('T3: a client reads comments.task_state', async () => {
    const res = await clientFor(client.id)
      .from('comments')
      .select('id, task_state')
      .eq('id', ctx.commentId);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data?.[0]?.task_state).toBe('assigned');
  });

  it('T4: a client cannot call comment_task_create', async () => {
    const res = await clientFor(client.id).rpc(
      'comment_task_create',
      createArgs(secondCommentId, ctx.channelId, 'Client try'),
    );
    expect(res.error?.message ?? '').toContain('not allowed');
    const link = await admin.from('comment_tasks').select('comment_id').eq('comment_id', secondCommentId);
    expect(link.data).toHaveLength(0);
  });

  it('T5: agency outside the chat cannot call comment_task_create', async () => {
    const res = await clientFor(outsiderAgency.id).rpc(
      'comment_task_create',
      createArgs(secondCommentId, ctx.channelId, 'Outsider try'),
    );
    expect(res.error?.message ?? '').toContain('not a member');
    const link = await admin.from('comment_tasks').select('comment_id').eq('comment_id', secondCommentId);
    expect(link.data).toHaveLength(0);
    const comment = await admin.from('comments').select('task_state').eq('id', secondCommentId);
    expect(comment.data?.[0]?.task_state).toBeNull();
  });

  it('T6: task done sets comments.task_state to done', async () => {
    const done = await admin.from('chat_tasks').update({ status: 'done' }).eq('id', taskId);
    expect(done.error).toBeNull();
    const comment = await admin.from('comments').select('task_state').eq('id', ctx.commentId);
    expect(comment.data?.[0]?.task_state).toBe('done');
  });

  it('T7: task deleted clears task_state and drops the link row', async () => {
    const del = await admin
      .from('chat_tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', taskId);
    expect(del.error).toBeNull();
    const comment = await admin.from('comments').select('task_state').eq('id', ctx.commentId);
    expect(comment.data?.[0]?.task_state).toBeNull();
    const link = await admin.from('comment_tasks').select('comment_id').eq('comment_id', ctx.commentId);
    expect(link.data).toHaveLength(0);
  });
});
