// Invite -> accept roundtrip, accept idempotency, and the send-window queue,
// exercised end to end against a local Supabase container. inviteMember runs as
// the authenticated owner (member_invite), records across email_threads +
// delivery_attempts via the service role, and hands the message to a fake
// sender so no real Resend call is made. Gated on WORKSPACE_SUITE so a plain
// `pnpm test` skips it.

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
  type EmailSender,
  type InviteEmailMessage,
} from '../../packages/workspace/src/index';

const WORKSPACE_SUITE = process.env.WORKSPACE_SUITE === '1';

const IN_WINDOW = new Date('2026-06-15T12:00:00.000Z'); // 12:00 in the UTC workspace
const OUT_OF_WINDOW = new Date('2026-06-15T23:00:00.000Z'); // 23:00, after the window

interface RecordingSender extends EmailSender {
  readonly calls: InviteEmailMessage[];
}

function recordingSender(id = 'resend_test_id'): RecordingSender {
  const calls: InviteEmailMessage[] = [];
  return {
    calls,
    async send(message: InviteEmailMessage): Promise<{ id: string }> {
      calls.push(message);
      return { id };
    },
  };
}

describe.runIf(WORKSPACE_SUITE)('workspace invite roundtrip', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let ws: SeededWorkspace;
  const invitees: SeededUser[] = [];

  function deps(sender: EmailSender, now: Date) {
    return {
      auth: clientFor(owner.id),
      service: admin,
      sender,
      appBaseUrl: 'https://app.srtd.io',
      fromAddress: 'invites@srtd.io',
      now,
    };
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    owner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `WS ${owner.email}`);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, ...invitees]);
  });

  it('invite (in window) -> accept, recording the Resend send', async () => {
    const env = loadRlsEnv();
    const invitee = await seedUser(env, admin);
    invitees.push(invitee);

    const sender = recordingSender('resend_sent_1');
    const invited = await inviteMember(deps(sender, IN_WINDOW), {
      workspaceId: ws.id,
      email: invitee.email,
      role: 'client',
      traceId: generateTraceId(),
    });
    if (!invited.ok) throw new Error(`invite failed: ${invited.error.code}`);
    expect(invited.data.status).toBe('sent');
    expect(invited.data.providerMessageId).toBe('resend_sent_1');

    // The send went out exactly once, addressed to the invitee.
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.to).toBe(invitee.email);
    expect(sender.calls[0]?.messageId).toBe(`<invite-${invited.data.memberId}@srtd.io>`);

    // email_threads recorded the conversation root.
    const thread = await admin
      .from('email_threads')
      .select('*')
      .eq('id', invited.data.emailThreadId)
      .single();
    expect(thread.data?.root_type).toBe('workspace_member');
    expect(thread.data?.root_id).toBe(invited.data.memberId);
    expect(thread.data?.message_id).toBe(`<invite-${invited.data.memberId}@srtd.io>`);
    expect(thread.data?.subject).toBe(`[${ws.name}] You have been invited.`);
    expect(thread.data?.last_sent_at).not.toBeNull();

    // delivery_attempts recorded the send.
    const attempt = await admin
      .from('delivery_attempts')
      .select('*')
      .eq('id', invited.data.deliveryAttemptId)
      .single();
    expect(attempt.data?.status).toBe('sent');
    expect(attempt.data?.provider).toBe('resend');
    expect(attempt.data?.template_key).toBe('member_invite');
    expect(attempt.data?.provider_message_id).toBe('resend_sent_1');
    expect(attempt.data?.email_thread_id).toBe(invited.data.emailThreadId);

    // The invitee accepts; the membership flips active.
    const accepted = await acceptInvite(
      { auth: clientFor(invitee.id), service: admin },
      { inviteId: invited.data.memberId, traceId: generateTraceId() },
    );
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.error.code}`);
    expect(accepted.data).toEqual({ memberId: invited.data.memberId, alreadyAccepted: false });

    const member = await admin
      .from('workspace_members')
      .select('active, accepted_at')
      .eq('id', invited.data.memberId)
      .single();
    expect(member.data?.active).toBe(true);
    expect(member.data?.accepted_at).not.toBeNull();
  });

  it('accept is idempotent on the invite token', async () => {
    const env = loadRlsEnv();
    const invitee = await seedUser(env, admin);
    invitees.push(invitee);

    const invited = await inviteMember(deps(recordingSender(), IN_WINDOW), {
      workspaceId: ws.id,
      email: invitee.email,
      role: 'client',
      traceId: generateTraceId(),
    });
    if (!invited.ok) throw new Error(`invite failed: ${invited.error.code}`);

    const acceptArgs = {
      auth: clientFor(invitee.id),
      service: admin,
    } as const;
    const first = await acceptInvite(acceptArgs, {
      inviteId: invited.data.memberId,
      traceId: generateTraceId(),
    });
    const second = await acceptInvite(acceptArgs, {
      inviteId: invited.data.memberId,
      traceId: generateTraceId(),
    });

    if (!first.ok || !second.ok) throw new Error('idempotent accept should resolve ok');
    expect(first.data.alreadyAccepted).toBe(false);
    expect(second.data).toEqual({ memberId: invited.data.memberId, alreadyAccepted: true });
  });

  it('queues (no send) outside the 9am-9pm window', async () => {
    const env = loadRlsEnv();
    const invitee = await seedUser(env, admin);
    invitees.push(invitee);

    const sender = recordingSender('should_not_be_used');
    const invited = await inviteMember(deps(sender, OUT_OF_WINDOW), {
      workspaceId: ws.id,
      email: invitee.email,
      role: 'client',
      traceId: generateTraceId(),
    });
    if (!invited.ok) throw new Error(`invite failed: ${invited.error.code}`);

    expect(invited.data.status).toBe('queued');
    expect(invited.data.providerMessageId).toBeNull();
    expect(invited.data.scheduledFor).toBe('2026-06-16T09:00:00.000Z');
    expect(sender.calls).toHaveLength(0);

    const attempt = await admin
      .from('delivery_attempts')
      .select('status, sent_at, provider_message_id')
      .eq('id', invited.data.deliveryAttemptId)
      .single();
    expect(attempt.data?.status).toBe('queued');
    expect(attempt.data?.sent_at).toBeNull();
    expect(attempt.data?.provider_message_id).toBeNull();
  });
});
