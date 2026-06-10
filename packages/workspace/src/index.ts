// @srtdio/workspace: the workspace + invite RPC layer (PR 8). Write paths wrap
// the member_invite / member_accept SECURITY DEFINER procs and record invite
// email; read paths are direct RLS-scoped SELECTs. No new procs, tables, or
// columns are introduced here.

export { acceptInvite, inviteMember } from './invite';
export type {
  AcceptInviteDeps,
  AcceptInviteInput,
  AcceptInviteResult,
  InviteMemberDeps,
  InviteMemberInput,
  InviteMemberResult,
  InviteSendStatus,
  MemberRole,
} from './invite';

export { countActiveMembers, listMembers, listWorkspaces, switchWorkspace } from './members';

export {
  computeSeatUsage,
  isPlanTier,
  PLAN_SEAT_LIMITS,
  PLAN_TIERS,
  seatLimitForPlan,
} from './seats';
export type { PlanTier, SeatUsage } from './seats';

export {
  createResendSender,
  INVITE_TEMPLATE_KEY,
  inviteEmailBody,
  inviteMessageId,
  inviteSubject,
} from './email';
export type { EmailSender, InviteEmailBodyInput, InviteEmailMessage, ResendConfig } from './email';

export { inviteSendSchedule, SEND_WINDOW_END_HOUR, SEND_WINDOW_START_HOUR } from './schedule';
export type { InviteSendSchedule } from './schedule';

export { fail, ok } from './result';

// Re-exported for consumers (edge functions) that branch on the shared Result.
export type { Client, DomainError, DomainErrorCode, Result } from '@srtdio/rpc';
