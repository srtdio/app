// Plan / Bank comment to task (20261113060000_plan_item_comment_tasks.sql),
// post comments' rule (comment-tasks.test.ts):
//
//   P1. A creator in the chat calls plan_item_comment_task_create: the task
//       lands in the chat, the plan_item_comment_tasks link row is written and
//       plan_item_comments.task_state is 'assigned'.
//   P2. The creator reads the link row; an approver reads none.
//   P3. An approver cannot call plan_item_comment_task_create ('not allowed').
//   P4. A second call on the same comment says 'task_exists'.
//   P5. Task done -> task_state 'done'; task deleted -> null and the link row is gone.
//
// Seeding goes through the service role and the plan procs (the privileged path).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  loadRlsEnv,
  randomSuffix,
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
type CreateArgs = Database['public']['Functions']['plan_item_comment_task_create']['Args'];

function createArgs(commentId: string, channelId: string, title: string): CreateArgs {
  return {
    p_comment_id: commentId,
    p_channel_id: channelId,
    p_title: title,
    p_priority: 1,
    p_due_on: '2026-12-01',
    p_trace_id: uuidv7(),
  };
}

/**
 * Typed pass-through for direct .rpc() args. Every proc here takes its own
 * p_trace_id (a uuid v7, set at every call site). callRpc() is the app
 * wrapper and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

/** Unwrap an rpc result or throw with the proc name and message. */
function must<T>(proc: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error !== null || res.data === null) {
    throw new Error(`${proc} failed: ${res.error?.message ?? 'no data'}`);
  }
  return res.data;
}

describe.runIf(RLS_SUITE)('plan_item_comment_tasks + plan_item_comment_task_create', () => {
  let admin: Client;
  let owner: SeededUser;
  let approver: SeededUser;
  let ws: SeededWorkspace;
  let ctx: Ctx;
  let commentId: string;
  let taskId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    const g = asGeneric(admin);
    owner = await seedUser(env, admin);
    approver = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan comment tasks ${owner.email}`);
    await seedMember(g, ws, approver, 'client');
    // The scaffold seeds a group chat whose only member is the owner.
    ctx = await seedScaffold(admin, ws);
    const owned = clientFor(owner.id);
    const planId = must(
      'plan_create',
      await owned.rpc(
        'plan_create',
        rpcArgs({
          p_workspace_id: ws.id,
          p_title: `Plan ${randomSuffix()}`,
          p_starts_on: '2026-11-01',
          p_ends_on: '2026-11-30',
          p_audience: 'client',
          p_trace_id: uuidv7(),
        }),
      ),
    );
    const itemId = must(
      'plan_concept_add',
      await owned.rpc(
        'plan_concept_add',
        rpcArgs({
          p_plan_id: planId,
          p_title: 'Concept',
          p_description: 'A concept',
          p_attachment_version_ids: [],
          p_trace_id: uuidv7(),
        }),
      ),
    );
    commentId = must(
      'plan_item_comment_send',
      await owned.rpc(
        'plan_item_comment_send',
        rpcArgs({
          p_item_id: itemId,
          // The proc takes null for a main comment; the generated type says string.
          p_parent_comment_id: null as unknown as string,
          p_body: 'Swap the cover',
          p_visibility: 'everyone',
          p_attachment_version_ids: [],
          p_trace_id: uuidv7(),
        }),
      ),
    );
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, approver]);
  });

  it('P1: a creator in the chat creates the task, link row and assigned state', async () => {
    const res = await clientFor(owner.id).rpc(
      'plan_item_comment_task_create',
      createArgs(commentId, ctx.channelId, 'Swap the cover'),
    );
    expect(res.error).toBeNull();
    const out = res.data as { task_id?: string } | null;
    expect(typeof out?.task_id).toBe('string');
    taskId = String(out?.task_id);
    const task = await admin.from('chat_tasks').select('channel_id, title').eq('id', taskId);
    expect(task.data?.[0]?.channel_id).toBe(ctx.channelId);
    expect(task.data?.[0]?.title).toBe('Swap the cover');
    const comment = await clientFor(owner.id)
      .from('plan_item_comments')
      .select('task_state')
      .eq('id', commentId);
    expect(comment.data?.[0]?.task_state).toBe('assigned');
  });

  it('P2: the creator reads the link row; an approver reads none', async () => {
    const own = await clientFor(owner.id)
      .from('plan_item_comment_tasks')
      .select('task_id')
      .eq('comment_id', commentId);
    expect(own.data).toHaveLength(1);
    expect(own.data?.[0]?.task_id).toBe(taskId);
    const theirs = await clientFor(approver.id)
      .from('plan_item_comment_tasks')
      .select('task_id')
      .eq('comment_id', commentId);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toHaveLength(0);
  });

  it('P3: an approver cannot call plan_item_comment_task_create', async () => {
    const res = await clientFor(approver.id).rpc(
      'plan_item_comment_task_create',
      createArgs(commentId, ctx.channelId, 'Approver try'),
    );
    expect(res.error?.message ?? '').toContain('not allowed');
  });

  it('P4: a second task on the same comment says task_exists', async () => {
    const res = await clientFor(owner.id).rpc(
      'plan_item_comment_task_create',
      createArgs(commentId, ctx.channelId, 'Again'),
    );
    expect(res.error?.message ?? '').toContain('task_exists');
  });

  it('P5: task done sets done; task deleted clears the state and the link', async () => {
    expect(
      (await admin.from('chat_tasks').update({ status: 'done' }).eq('id', taskId)).error,
    ).toBeNull();
    const done = await clientFor(owner.id)
      .from('plan_item_comments')
      .select('task_state')
      .eq('id', commentId);
    expect(done.data?.[0]?.task_state).toBe('done');
    const del = await admin
      .from('chat_tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', taskId);
    expect(del.error).toBeNull();
    const cleared = await clientFor(owner.id)
      .from('plan_item_comments')
      .select('task_state')
      .eq('id', commentId);
    expect(cleared.data?.[0]?.task_state).toBeNull();
    const link = await clientFor(owner.id)
      .from('plan_item_comment_tasks')
      .select('task_id')
      .eq('comment_id', commentId);
    expect(link.data).toHaveLength(0);
  });
});
