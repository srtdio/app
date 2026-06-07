// Mention validation: every @[user_id] in a comment body must resolve to an
// active member of the target workspace, or createComment rejects the call with
// invalid_mention before the comment_create proc ever runs.

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
import { createComment, type Client } from '../../packages/comments/src/index';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';
const ABSENT_USER_ID = '99999999-9999-4999-8999-999999999999';

describe.runIf(COMMENTS_SUITE)('comment mention validation', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let activeMember: SeededUser;
  let inactiveMember: SeededUser;
  let wsA: SeededWorkspace;
  let ctxA: Ctx;
  let ownerClient: Client;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Mentions A ${owner.email}`);
    ctxA = await seedScaffold(admin, wsA);
    ownerClient = clientFor(owner.id);

    activeMember = await seedUser(env, admin);
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: wsA.id,
      user_id: activeMember.id,
      role: 'agency',
      active: true,
      accepted_at: new Date().toISOString(),
    });

    // Seeded as a non-active member (e.g. removed / not yet accepted).
    inactiveMember = await seedUser(env, admin);
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: wsA.id,
      user_id: inactiveMember.id,
      role: 'agency',
      active: false,
    });
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA], [owner, activeMember, inactiveMember]);
  });

  it('accepts a mention of an active member', async () => {
    const result = await createComment(ownerClient, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      body: `over to you @[${activeMember.id}]`,
      trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a mention of a user who is not a member', async () => {
    const result = await createComment(ownerClient, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      body: `hello @[${ABSENT_USER_ID}]`,
      trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_mention');
      expect(result.error.invalidMentions).toEqual([ABSENT_USER_ID]);
    }
  });

  it('rejects a mention of an inactive member', async () => {
    const result = await createComment(ownerClient, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      body: `ping @[${inactiveMember.id}]`,
      trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_mention');
      expect(result.error.invalidMentions).toEqual([inactiveMember.id]);
    }
  });

  it('rejects when an explicit mention is not an active member', async () => {
    const result = await createComment(ownerClient, {
      workspace_id: wsA.id,
      entity_type: 'post',
      entity_id: ctxA.postId,
      body: 'no body token here',
      mentions: [ABSENT_USER_ID],
      trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_mention');
  });
});
