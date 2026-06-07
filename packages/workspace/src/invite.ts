// inviteMember / acceptInvite: the two write paths of the workspace package.
//
// inviteMember wraps public.member_invite (run as the authenticated caller, so
// auth.uid() is the actor), then records the Resend send across email_threads +
// delivery_attempts. The recording uses the service-role client because the
// authenticated role has no write grant on those tenant tables; the proc itself
// is the only authenticated write.
//
// acceptInvite wraps public.member_accept and is idempotent on the invite token
// (the member id that member_invite returns): re-accepting the same token after
// it is already active resolves ok instead of surfacing invalid_payload.

import { memberAccept, memberInvite } from '@srtdio/rpc';
import type { Client, Result } from '@srtdio/rpc';
import { fail, ok } from './result';
import { INVITE_TEMPLATE_KEY, inviteEmailBody, inviteMessageId, inviteSubject } from './email';
import type { EmailSender } from './email';
import { inviteSendSchedule } from './schedule';

export type MemberRole = 'admin' | 'agency' | 'client';

export interface InviteMemberInput {
  workspaceId: string;
  email: string;
  role: MemberRole;
  traceId: string;
}

export interface InviteMemberDeps {
  /** Authenticated client; member_invite runs as this user (auth.uid()). */
  auth: Client;
  /** Service-role client; reads workspace metadata and records the send. */
  service: Client;
  /** Transport that hands the message to Resend. */
  sender: EmailSender;
  /** Base URL the invitee follows to accept, e.g. https://app.srtd.io. */
  appBaseUrl: string;
  /** Verified Resend sender identity. */
  fromAddress: string;
  /** Injectable clock; defaults to the wall clock. */
  now?: Date;
}

export type InviteSendStatus = 'sent' | 'queued' | 'failed';

export interface InviteMemberResult {
  /** workspace_members.id of the pending invite, also the accept token. */
  memberId: string;
  emailThreadId: string;
  deliveryAttemptId: string;
  status: InviteSendStatus;
  /** ISO instant the message went out (sent) or is queued for (queued). */
  scheduledFor: string;
  providerMessageId: string | null;
}

export async function inviteMember(
  deps: InviteMemberDeps,
  input: InviteMemberInput,
): Promise<Result<InviteMemberResult>> {
  const invited = await memberInvite(deps.auth, {
    p_workspace_id: input.workspaceId,
    p_email: input.email,
    p_role: input.role,
    p_trace_id: input.traceId,
  });
  if (!invited.ok) return invited;
  const memberId = invited.data;

  // Workspace name (subject) and timezone (send-window gate).
  const workspace = await deps.service
    .from('workspaces')
    .select('name, timezone')
    .eq('id', input.workspaceId)
    .maybeSingle();
  if (workspace.error || !workspace.data) {
    return fail('unknown', `workspace lookup failed: ${workspace.error?.message ?? 'not found'}`);
  }

  const now = deps.now ?? new Date();
  const schedule = inviteSendSchedule(workspace.data.timezone, now);
  const messageId = inviteMessageId(memberId);
  const subject = inviteSubject(workspace.data.name);

  // email_threads is the durable conversation root, keyed by the deterministic
  // Message-ID so a later resend threads onto it.
  const thread = await deps.service
    .from('email_threads')
    .insert({
      workspace_id: input.workspaceId,
      root_type: 'workspace_member',
      root_id: memberId,
      message_id: messageId,
      subject,
      last_sent_at: schedule.sendNow ? now.toISOString() : null,
    })
    .select('id')
    .single();
  if (thread.error || !thread.data) {
    return fail('unknown', `email_threads insert failed: ${thread.error?.message ?? 'no row'}`);
  }
  const emailThreadId = thread.data.id;

  let status: InviteSendStatus = schedule.sendNow ? 'sent' : 'queued';
  let providerMessageId: string | null = null;
  let sendError: string | null = null;

  if (schedule.sendNow) {
    const body = inviteEmailBody({
      workspaceName: workspace.data.name,
      role: input.role,
      acceptUrl: `${deps.appBaseUrl}/invites/${memberId}/accept`,
    });
    try {
      const delivered = await deps.sender.send({
        to: input.email,
        from: deps.fromAddress,
        subject,
        messageId,
        html: body.html,
        text: body.text,
      });
      providerMessageId = delivered.id;
    } catch (err) {
      status = 'failed';
      sendError = err instanceof Error ? err.message : String(err);
    }
  }

  const attempt = await deps.service
    .from('delivery_attempts')
    .insert({
      workspace_id: input.workspaceId,
      channel: 'email',
      template_key: INVITE_TEMPLATE_KEY,
      provider: 'resend',
      provider_message_id: providerMessageId,
      status,
      sent_at: status === 'sent' ? now.toISOString() : null,
      error: sendError,
      email_thread_id: emailThreadId,
    })
    .select('id')
    .single();
  if (attempt.error || !attempt.data) {
    return fail(
      'unknown',
      `delivery_attempts insert failed: ${attempt.error?.message ?? 'no row'}`,
    );
  }

  return ok({
    memberId,
    emailThreadId,
    deliveryAttemptId: attempt.data.id,
    status,
    scheduledFor: schedule.scheduledFor,
    providerMessageId,
  });
}

export interface AcceptInviteInput {
  /** The invite token: the member id member_invite returned. */
  inviteId: string;
  traceId: string;
}

export interface AcceptInviteDeps {
  /** Authenticated client; member_accept enforces caller == invitee. */
  auth: Client;
  /** Service-role client; confirms idempotency on a repeat accept. */
  service: Client;
}

export interface AcceptInviteResult {
  memberId: string;
  /** True when the invite was already active and this call was a no-op. */
  alreadyAccepted: boolean;
}

export async function acceptInvite(
  deps: AcceptInviteDeps,
  input: AcceptInviteInput,
): Promise<Result<AcceptInviteResult>> {
  const accepted = await memberAccept(deps.auth, {
    p_invite_id: input.inviteId,
    p_trace_id: input.traceId,
  });
  if (accepted.ok) return ok({ memberId: accepted.data, alreadyAccepted: false });

  // member_accept raises invalid_payload for both an unknown invite and one that
  // is already active. A different user re-accepting is rejected earlier with
  // forbidden_role, so reaching invalid_payload from the rightful invitee means
  // the invite already landed: confirm it is active and treat it as a no-op.
  if (accepted.error.code === 'invalid_payload') {
    const existing = await deps.service
      .from('workspace_members')
      .select('id, active, accepted_at')
      .eq('id', input.inviteId)
      .maybeSingle();
    if (!existing.error && existing.data && existing.data.active && existing.data.accepted_at) {
      return ok({ memberId: input.inviteId, alreadyAccepted: true });
    }
  }
  return accepted;
}
