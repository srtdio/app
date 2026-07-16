// DB-backed coverage for public.post_ready_notify (migration
// 20260716120000_feedback_ledger.sql). Unlike the rest of the posts suite
// (pure boundary specs over the fake transport in ./helpers.ts), this proc's
// contract is entirely database side effects: the inbox fan-out and the
// clean-ledger gate. So this file follows the comments/rpc integration model
// instead (packages/test-utils/rls.ts): service-role seeding, procs exercised
// as the AUTHENTICATED role.
//
// The posts vitest config has no database globalSetup, so these specs are
// skipped unless a local Supabase stack is reachable. They run when either:
//   * the comments/rls suite's stack is up (its env handoff file exists), or
//   * POSTS_DB_SUITE=1, in which case this file brings the stack up and tears
//     it down itself via the shared tests/rls/setup.ts bring-up:
//       POSTS_DB_SUITE=1 pnpm exec vitest run --config tests/posts/vitest.config.ts tests/posts/ready-notify.test.ts

import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  rlsEnvFile,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import { setup as bringUpStack, teardown as tearDownStack } from '../rls/setup';
import { widenLocalInboxEventTypes } from '../comments/setup';

const stackAlreadyUp = existsSync(rlsEnvFile);
const SELF_MANAGED = process.env.POSTS_DB_SUITE === '1' && !stackAlreadyUp;
const DB_AVAILABLE = stackAlreadyUp || process.env.POSTS_DB_SUITE === '1';

type Db = SupabaseClient<Database>;

/** The inbox columns the fan-out assertions read back through the admin client. */
interface InboxRow {
  user_id: string;
  tier: string;
  payload: Record<string, unknown> | null;
}

describe.runIf(DB_AVAILABLE)('post_ready_notify (authenticated role)', () => {
  let admin: Db;
  let owner: SeededUser;
  let agencyUser: SeededUser;
  let clientUser1: SeededUser;
  let clientUser2: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let agencyClient: Db;
  let client1: Db;
  let ownerClient: Db;

  async function addMember(user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: wsA.id,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  async function insertPost(stage: string): Promise<string> {
    const g = asGeneric(admin);
    const row = await insertRow(g, 'posts', {
      workspace_id: wsA.id,
      number: await nextEntityNumber(g, wsA.id),
      title: 'Ready post',
      bucket_id: ctxA.bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: owner.id,
      stage,
    });
    return String(row.id);
  }

  /** Create checkpoints on a post as the client member; returns the comment ids. */
  async function batchCheckpoints(postId: string, bodies: string[]): Promise<string[]> {
    const args = {
      p_workspace_id: wsA.id,
      p_post_id: postId,
      p_points: bodies.map((body) => ({ body })),
      p_trace_id: generateTraceId(),
    };
    const { data, error } = await client1.rpc('comment_batch_create', args);
    if (error) throw new Error(`comment_batch_create failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error('expected a jsonb array of {id, seq}');
    return (data as Array<{ id: string }>).map((row) => row.id);
  }

  async function resolveCheckpoint(commentId: string): Promise<void> {
    const args = {
      p_comment_id: commentId,
      p_resolved: true,
      p_trace_id: generateTraceId(),
    };
    const { error } = await ownerClient.rpc('comment_resolve', args);
    if (error) throw new Error(`comment_resolve failed: ${error.message}`);
  }

  function readyNotify(caller: Db, postId: string) {
    const args = { p_post_id: postId, p_trace_id: generateTraceId() };
    return caller.rpc('post_ready_notify', args);
  }

  async function readyEntries(postId: string): Promise<InboxRow[]> {
    const res = await asGeneric(admin)
      .from('inbox_entries')
      .select('user_id, tier, payload')
      .eq('event_type', 'post_ready')
      .eq('entity_id', postId);
    if (res.error) throw new Error(`inbox_entries read failed: ${res.error.message}`);
    return (res.data ?? []) as InboxRow[];
  }

  beforeAll(async () => {
    if (SELF_MANAGED) await bringUpStack();
    const env = loadRlsEnv();
    // Local-only inbox event-type widening; see tests/comments/setup.ts. Needed
    // here too because the rls suite's bring-up does not apply it.
    widenLocalInboxEventTypes(env.dbUrl);
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Ready A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);
    ownerClient = clientFor(owner.id);

    agencyUser = await seedUser(env, admin);
    clientUser1 = await seedUser(env, admin);
    clientUser2 = await seedUser(env, admin);
    await addMember(agencyUser, 'agency');
    await addMember(clientUser1, 'client');
    await addMember(clientUser2, 'client');
    agencyClient = clientFor(agencyUser.id);
    client1 = clientFor(clientUser1.id);
  }, 300_000);

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA], [owner, agencyUser, clientUser1, clientUser2]);
    if (SELF_MANAGED) await tearDownStack();
  }, 120_000);

  it('agency happy path: one urgent entry per client member, none to the caller', async () => {
    const postId = await insertPost('review');
    const checkpoints = await batchCheckpoints(postId, ['tighten the hook', 'logo too small']);
    for (const id of checkpoints) await resolveCheckpoint(id);

    const { error } = await readyNotify(agencyClient, postId);
    expect(error).toBeNull();

    const entries = await readyEntries(postId);
    const byUser = new Map(entries.map((row) => [row.user_id, row]));
    expect(entries).toHaveLength(2);
    expect(byUser.get(clientUser1.id)?.tier).toBe('urgent');
    expect(byUser.get(clientUser2.id)?.tier).toBe('urgent');
    expect(byUser.get(clientUser1.id)?.payload?.['checkpoints']).toBe(2);
    expect(byUser.get(clientUser2.id)?.payload?.['checkpoints']).toBe(2);
    expect(byUser.has(agencyUser.id)).toBe(false);
    expect(byUser.has(owner.id)).toBe(false);
  }, 30_000);

  it('an open checkpoint raises checkpoints_open and writes nothing', async () => {
    const postId = await insertPost('review');
    await batchCheckpoints(postId, ['unresolved point']);

    const { error } = await readyNotify(agencyClient, postId);
    expect(error?.message).toBe('checkpoints_open');
    expect(await readyEntries(postId)).toHaveLength(0);
  }, 30_000);

  it('a client caller is rejected with forbidden_role', async () => {
    const postId = await insertPost('review');
    const { error } = await readyNotify(client1, postId);
    expect(error?.message).toBe('forbidden_role');
    expect(await readyEntries(postId)).toHaveLength(0);
  }, 30_000);

  it('a non-review stage is rejected with invalid_stage', async () => {
    const postId = await insertPost('draft');
    const { error } = await readyNotify(agencyClient, postId);
    expect(error?.message).toBe('invalid_stage');
    expect(await readyEntries(postId)).toHaveLength(0);
  }, 30_000);

  it('a zero-checkpoint ping succeeds with checkpoints=0', async () => {
    const postId = await insertPost('review');
    const { error } = await readyNotify(agencyClient, postId);
    expect(error).toBeNull();

    const entries = await readyEntries(postId);
    expect(entries).toHaveLength(2);
    for (const row of entries) {
      expect(row.tier).toBe('urgent');
      expect(row.payload?.['checkpoints']).toBe(0);
      expect([clientUser1.id, clientUser2.id]).toContain(row.user_id);
    }
  }, 30_000);
});
