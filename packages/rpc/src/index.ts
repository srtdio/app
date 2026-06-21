// @srtdio/rpc: typed, Result-returning wrappers around the SECURITY DEFINER
// write procs (migration 20260606130000_security_definer_write_procs.sql). One
// function per client-facing proc. These never throw for expected (domain)
// failures; they return { ok: false, error } so callers branch instead of catch.
//
// Argument shapes are taken verbatim from the generated Supabase types, so a
// proc signature change surfaces here as a type error. trace_id is carried as
// the p_trace_id member of each args object and is never inferred.
//
// inbox_entry_create is intentionally absent: it has no EXECUTE grant to the
// authenticated role (server / service-role callers only), so there is no
// client-facing wrapper for it.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';

type Functions = Database['public']['Functions'];
type FunctionName = keyof Functions;
type ProcArgs<N extends FunctionName> = Functions[N]['Args'];
type ProcReturns<N extends FunctionName> = Functions[N]['Returns'];

/** A Supabase client typed against the live schema. */
export type Client = SupabaseClient<Database>;

/** The domain-named exceptions the procs raise. Anything else maps to 'unknown'. */
export const DOMAIN_ERROR_CODES = [
  'forbidden_role',
  'invalid_stage_transition',
  'workspace_member_only',
  'invalid_payload',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number] | 'unknown';

export interface DomainError {
  /** The matched domain code, or 'unknown' for an unexpected/transport error. */
  code: DomainErrorCode;
  /** The raw Postgres/PostgREST error message, for logging. */
  message: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: DomainError };

function toDomainError(message: string): DomainError {
  const known = (DOMAIN_ERROR_CODES as readonly string[]).includes(message);
  return { code: known ? (message as DomainErrorCode) : 'unknown', message };
}

/**
 * Invoke a proc and adapt PostgREST's { data, error } into a Result. The args
 * object (which includes p_trace_id) is passed through unchanged.
 */
async function callProc<N extends FunctionName>(
  client: Client,
  fn: N,
  args: ProcArgs<N>,
): Promise<Result<ProcReturns<N>>> {
  const { data, error } = await client.rpc(fn, args);
  if (error) return { ok: false, error: toDomainError(error.message) };
  return { ok: true, data: data as ProcReturns<N> };
}

export type StageTransitionArgs = ProcArgs<'stage_transition'>;
export function stageTransition(
  client: Client,
  args: StageTransitionArgs,
): Promise<Result<ProcReturns<'stage_transition'>>> {
  return callProc(client, 'stage_transition', args);
}

export type PostCreateArgs = ProcArgs<'post_create'>;
export function postCreate(
  client: Client,
  args: PostCreateArgs,
): Promise<Result<ProcReturns<'post_create'>>> {
  return callProc(client, 'post_create', args);
}

export type PostVersionCreateArgs = ProcArgs<'post_version_create'>;
export function postVersionCreate(
  client: Client,
  args: PostVersionCreateArgs,
): Promise<Result<ProcReturns<'post_version_create'>>> {
  return callProc(client, 'post_version_create', args);
}

export type PostUpdateArgs = ProcArgs<'post_update'>;
export function postUpdate(
  client: Client,
  args: PostUpdateArgs,
): Promise<Result<ProcReturns<'post_update'>>> {
  return callProc(client, 'post_update', args);
}

export type PostCaptionUpdateArgs = ProcArgs<'post_caption_update'>;
export function postCaptionUpdate(
  client: Client,
  args: PostCaptionUpdateArgs,
): Promise<Result<ProcReturns<'post_caption_update'>>> {
  return callProc(client, 'post_caption_update', args);
}

export type GallerySetArgs = ProcArgs<'gallery_set'>;
export function gallerySet(
  client: Client,
  args: GallerySetArgs,
): Promise<Result<ProcReturns<'gallery_set'>>> {
  return callProc(client, 'gallery_set', args);
}

export type AnnotationCreateArgs = ProcArgs<'annotation_create'>;
export function annotationCreate(
  client: Client,
  args: AnnotationCreateArgs,
): Promise<Result<ProcReturns<'annotation_create'>>> {
  return callProc(client, 'annotation_create', args);
}

export type MemberInviteArgs = ProcArgs<'member_invite'>;
export function memberInvite(
  client: Client,
  args: MemberInviteArgs,
): Promise<Result<ProcReturns<'member_invite'>>> {
  return callProc(client, 'member_invite', args);
}

export type MemberAcceptArgs = ProcArgs<'member_accept'>;
export function memberAccept(
  client: Client,
  args: MemberAcceptArgs,
): Promise<Result<ProcReturns<'member_accept'>>> {
  return callProc(client, 'member_accept', args);
}

export type BriefCreateArgs = ProcArgs<'brief_create'>;
export function briefCreate(
  client: Client,
  args: BriefCreateArgs,
): Promise<Result<ProcReturns<'brief_create'>>> {
  return callProc(client, 'brief_create', args);
}

export type BriefCloseArgs = ProcArgs<'brief_close'>;
export function briefClose(
  client: Client,
  args: BriefCloseArgs,
): Promise<Result<ProcReturns<'brief_close'>>> {
  return callProc(client, 'brief_close', args);
}

export type AssetDeleteArgs = ProcArgs<'asset_delete'>;
export function assetDelete(
  client: Client,
  args: AssetDeleteArgs,
): Promise<Result<ProcReturns<'asset_delete'>>> {
  return callProc(client, 'asset_delete', args);
}

export type CommentCreateArgs = ProcArgs<'comment_create'>;
export function commentCreate(
  client: Client,
  args: CommentCreateArgs,
): Promise<Result<ProcReturns<'comment_create'>>> {
  return callProc(client, 'comment_create', args);
}

export type CommentEditArgs = ProcArgs<'comment_edit'>;
export function commentEdit(
  client: Client,
  args: CommentEditArgs,
): Promise<Result<ProcReturns<'comment_edit'>>> {
  return callProc(client, 'comment_edit', args);
}

export type CommentSoftDeleteArgs = ProcArgs<'comment_soft_delete'>;
export function commentSoftDelete(
  client: Client,
  args: CommentSoftDeleteArgs,
): Promise<Result<ProcReturns<'comment_soft_delete'>>> {
  return callProc(client, 'comment_soft_delete', args);
}

export type WorkspaceCreateArgs = ProcArgs<'workspace_create'>;
export function workspaceCreate(
  client: Client,
  args: WorkspaceCreateArgs,
): Promise<Result<ProcReturns<'workspace_create'>>> {
  return callProc(client, 'workspace_create', args);
}

export type GroupCreateArgs = ProcArgs<'group_create'>;
export function groupCreate(
  client: Client,
  args: GroupCreateArgs,
): Promise<Result<ProcReturns<'group_create'>>> {
  return callProc(client, 'group_create', args);
}

export type GroupRenameArgs = ProcArgs<'group_rename'>;
export function groupRename(
  client: Client,
  args: GroupRenameArgs,
): Promise<Result<ProcReturns<'group_rename'>>> {
  return callProc(client, 'group_rename', args);
}

export type GroupMemberAddArgs = ProcArgs<'group_member_add'>;
export function groupMemberAdd(
  client: Client,
  args: GroupMemberAddArgs,
): Promise<Result<ProcReturns<'group_member_add'>>> {
  return callProc(client, 'group_member_add', args);
}

export type GroupMemberRemoveArgs = ProcArgs<'group_member_remove'>;
export function groupMemberRemove(
  client: Client,
  args: GroupMemberRemoveArgs,
): Promise<Result<ProcReturns<'group_member_remove'>>> {
  return callProc(client, 'group_member_remove', args);
}

export type GroupLeaveArgs = ProcArgs<'group_leave'>;
export function groupLeave(
  client: Client,
  args: GroupLeaveArgs,
): Promise<Result<ProcReturns<'group_leave'>>> {
  return callProc(client, 'group_leave', args);
}

export type DmChannelEnsureArgs = ProcArgs<'dm_channel_ensure'>;
export function dmChannelEnsure(
  client: Client,
  args: DmChannelEnsureArgs,
): Promise<Result<ProcReturns<'dm_channel_ensure'>>> {
  return callProc(client, 'dm_channel_ensure', args);
}

export type InboxMarkReadArgs = ProcArgs<'inbox_mark_read'>;
export function inboxMarkRead(
  client: Client,
  args: InboxMarkReadArgs,
): Promise<Result<ProcReturns<'inbox_mark_read'>>> {
  return callProc(client, 'inbox_mark_read', args);
}

export type InboxMarkAllReadArgs = ProcArgs<'inbox_mark_all_read'>;
export function inboxMarkAllRead(
  client: Client,
  args: InboxMarkAllReadArgs,
): Promise<Result<ProcReturns<'inbox_mark_all_read'>>> {
  return callProc(client, 'inbox_mark_all_read', args);
}

export type InboxSnoozeArgs = ProcArgs<'inbox_snooze'>;
export function inboxSnooze(
  client: Client,
  args: InboxSnoozeArgs,
): Promise<Result<ProcReturns<'inbox_snooze'>>> {
  return callProc(client, 'inbox_snooze', args);
}

export type UserProfileUpdateArgs = ProcArgs<'user_profile_update'>;
export function userProfileUpdate(
  client: Client,
  args: UserProfileUpdateArgs,
): Promise<Result<ProcReturns<'user_profile_update'>>> {
  return callProc(client, 'user_profile_update', args);
}
