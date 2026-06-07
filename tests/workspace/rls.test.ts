// Cross-tenant isolation for the workspace read/accept paths. The headline case
// (per the PR scope): an invite issued in workspace A cannot be accepted by a
// workspace-B principal. We also prove the RLS-scoped reads do not leak A's
// membership or workspace to a B user. Gated on WORKSPACE_SUITE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  loadRlsEnv,
  seedUser,
  seedWorkspace,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  acceptInvite,
  inviteMember,
  listMembers,
  listWorkspaces,
  switchWorkspace,
  type EmailSender,
} from '../../packages/workspace/src/index';

const WORKSPACE_SUITE = process.env.WORKSPACE_SUITE === '1';
const IN_WINDOW = new Date('2026-06-15T12:00:00.000Z');

const noopSender: EmailSender = {
  async send(): Promise<{ id: string }> {
    return { id: 'resend_noop' };
  },
};

describe.runIf(WORKSPACE_SUITE)('workspace cross-tenant isolation', () => {
  let admin: SupabaseClient<Database>;
  let ownerA: SeededUser;
  let ownerB: SeededUser;
  let inviteeA: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let inviteId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    ownerA = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, ownerA, `WS A ${ownerA.email}`);
    ownerB = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, ownerB, `WS B ${ownerB.email}`);
    inviteeA = await seedUser(env, admin);

    const invited = await inviteMember(
      {
        auth: clientFor(ownerA.id),
        service: admin,
        sender: noopSender,
        fromAddress: 'invites@srtd.io',
        now: IN_WINDOW,
      },
      {
        workspaceId: wsA.id,
        email: inviteeA.email,
        role: 'client',
        traceId: generateTraceId(),
        inviteLink: 'https://app.srtd.io/w/a',
      },
    );
    if (!invited.ok) throw new Error(`setup invite failed: ${invited.error.code}`);
    inviteId = invited.data.memberId;
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [ownerA, ownerB, inviteeA]);
  });

  it('a workspace-B principal cannot accept a workspace-A invite', async () => {
    const result = await acceptInvite(
      { auth: clientFor(ownerB.id), service: admin },
      { inviteId, traceId: generateTraceId() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden_role');

    // The invite is untouched: still inactive, never accepted.
    const member = await admin
      .from('workspace_members')
      .select('active, accepted_at')
      .eq('id', inviteId)
      .single();
    expect(member.data?.active).toBe(false);
    expect(member.data?.accepted_at).toBeNull();
  });

  it('listMembers hides workspace A members from a workspace-B user', async () => {
    const fromB = await listMembers(clientFor(ownerB.id), wsA.id);
    if (!fromB.ok) throw new Error(`listMembers(B) errored: ${fromB.error.code}`);
    expect(fromB.data).toHaveLength(0);

    const fromA = await listMembers(clientFor(ownerA.id), wsA.id);
    if (!fromA.ok) throw new Error(`listMembers(A) errored: ${fromA.error.code}`);
    expect(fromA.data.length).toBeGreaterThanOrEqual(1);
  });

  it('switchWorkspace denies a workspace a user is not a member of', async () => {
    const denied = await switchWorkspace(clientFor(ownerB.id), wsA.id);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('workspace_member_only');

    const allowed = await switchWorkspace(clientFor(ownerA.id), wsA.id);
    if (!allowed.ok) throw new Error(`switchWorkspace(A) errored: ${allowed.error.code}`);
    expect(allowed.data.id).toBe(wsA.id);
  });

  it('listWorkspaces returns only the caller own memberships', async () => {
    const forB = await listWorkspaces(clientFor(ownerB.id));
    if (!forB.ok) throw new Error(`listWorkspaces(B) errored: ${forB.error.code}`);
    const ids = forB.data.map((w) => w.id);
    expect(ids).toContain(wsB.id);
    expect(ids).not.toContain(wsA.id);
  });
});
