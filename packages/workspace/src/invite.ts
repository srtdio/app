// inviteMember / acceptInvite: the two write paths of the workspace package.
//
// inviteMember wraps public.member_invite (run as the authenticated caller, so
// auth.uid() is the actor), sends the branded invite via Resend, and records the
// send in delivery_attempts (email_thread_id null). It does NOT write
// email_threads: that table's live CHECK constraints accept only brief/post
// roots and <(brief|post)-...> Message-IDs, so an invite cannot be threaded
// without a schema change, which is out of scope for this wave. The recording
// uses the service-role client because the authenticated role has no write grant
// on delivery_attempts; the proc itself is the only authenticated write.
//
// The caller (the invite-send edge function) resolves inviteLink first: a
// type=invite action link from auth.admin.generateLink for a brand-new invitee,
// or a workspace deep-link when the user already exists in auth.users. That
// keeps the auth-admin step at the edge and member_invite able to find the row.
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
  /** Resolved link embedded in the email: invite action link or deep-link. */
  inviteLink: string;
}

export interface InviteMemberDeps {
  /** Authenticated client; member_invite runs as this user (auth.uid()). */
  auth: Client;
  /** Service-role client; reads workspace metadata and records the send. */
  service: Client;
  /** Transport that hands the message to Resend. */
  sender: EmailSender;
  /** Verified Resend sender identity. */
  fromAddress: string;
  /** Injectable clock; defaults to the wall clock. */
  now?: Date;
}

export type InviteSendStatus = 'sent' | 'queued' | 'failed';

export interface InviteMemberResult {
  /** workspace_members.id of the pending invite, also the accept token. */
  memberId: string;
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

  let status: InviteSendStatus = schedule.sendNow ? 'sent' : 'queued';
  let providerMessageId: string | null = null;
  let sendError: string | null = null;

  if (schedule.sendNow) {
    const body = inviteEmailBody({
      workspaceName: workspace.data.name,
      role: input.role,
      acceptUrl: input.inviteLink,
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

  // email_thread_id is null: invites are not threaded (see the file header).
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
      email_thread_id: null,
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
