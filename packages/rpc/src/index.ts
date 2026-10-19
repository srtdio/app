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
import type { Database, Json } from '@srtdio/schemas';

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

export type PostSoftDeleteArgs = ProcArgs<'post_soft_delete'>;
export function postSoftDelete(
  client: Client,
  args: PostSoftDeleteArgs,
): Promise<Result<ProcReturns<'post_soft_delete'>>> {
  return callProc(client, 'post_soft_delete', args);
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

export type MemberRemoveArgs = ProcArgs<'member_remove'>;
export function memberRemove(
  client: Client,
  args: MemberRemoveArgs,
): Promise<Result<ProcReturns<'member_remove'>>> {
  return callProc(client, 'member_remove', args);
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

export type AssetDeleteManyArgs = ProcArgs<'asset_delete_many'>;
export function assetDeleteMany(
  client: Client,
  args: AssetDeleteManyArgs,
): Promise<Result<ProcReturns<'asset_delete_many'>>> {
  return callProc(client, 'asset_delete_many', args);
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

export type CommentResolveArgs = ProcArgs<'comment_resolve'>;
export function commentResolve(
  client: Client,
  args: CommentResolveArgs,
): Promise<Result<ProcReturns<'comment_resolve'>>> {
  return callProc(client, 'comment_resolve', args);
}

export type CommentDeleteArgs = ProcArgs<'comment_delete'>;
export function commentDelete(
  client: Client,
  args: CommentDeleteArgs,
): Promise<Result<ProcReturns<'comment_delete'>>> {
  return callProc(client, 'comment_delete', args);
}

export type CheckpointAcceptArgs = ProcArgs<'checkpoint_accept'>;
export function checkpointAccept(
  client: Client,
  args: CheckpointAcceptArgs,
): Promise<Result<ProcReturns<'checkpoint_accept'>>> {
  return callProc(client, 'checkpoint_accept', args);
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

// Onboarding (migration 20261014140000_onboarding_username_default_group).
export type UserOnboardingSaveArgs = ProcArgs<'user_onboarding_save'>;
export function userOnboardingSave(
  client: Client,
  args: UserOnboardingSaveArgs,
): Promise<Result<ProcReturns<'user_onboarding_save'>>> {
  return callProc(client, 'user_onboarding_save', args);
}

export type UsernameAvailableArgs = ProcArgs<'username_available'>;
export function usernameAvailable(
  client: Client,
  args: UsernameAvailableArgs,
): Promise<Result<ProcReturns<'username_available'>>> {
  return callProc(client, 'username_available', args);
}

export type UsernameSetArgs = ProcArgs<'username_set'>;
export function usernameSet(
  client: Client,
  args: UsernameSetArgs,
): Promise<Result<ProcReturns<'username_set'>>> {
  return callProc(client, 'username_set', args);
}

export type MemberJoinGroupSetArgs = ProcArgs<'member_join_group_set'>;
export function memberJoinGroupSet(
  client: Client,
  args: MemberJoinGroupSetArgs,
): Promise<Result<ProcReturns<'member_join_group_set'>>> {
  return callProc(client, 'member_join_group_set', args);
}

// Plans in chat (migrations 20261009110000_plans_core, 20261009163000_chat_plan_share,
// 20261009205500_plan_item_comments, 20261011011500_plan_drafts_in_client_plans).
// Every write proc takes p_trace_id; plan_draft_rows is a read-only, batched
// helper (no trace id, no audit) listing the draft post rows of up to 100
// plans. plan_draft_items is retired (no EXECUTE) and has no wrapper.

export type PlanCreateArgs = ProcArgs<'plan_create'>;
export function planCreate(
  client: Client,
  args: PlanCreateArgs,
): Promise<Result<ProcReturns<'plan_create'>>> {
  return callProc(client, 'plan_create', args);
}

/** One concept for plan_create_with_items, in screen order. */
export interface PlanCreateConcept {
  title: string;
  description: string;
  attachment_version_ids: string[];
  /** 'YYYY-MM-DD', or null for no date. */
  target_date: string | null;
}

/** One post for plan_create_with_items; null target_date clears its Pipeline date. */
export interface PlanCreatePost {
  post_id: string;
  target_date: string | null;
}

/**
 * plan_create_with_items: the plan, its concepts and its posts in one
 * transaction (any failure saves nothing). The generated Args type the two
 * lists as Json; this wrapper types them.
 */
export type PlanCreateWithItemsArgs = Omit<
  ProcArgs<'plan_create_with_items'>,
  'p_concepts' | 'p_posts'
> & {
  p_concepts: PlanCreateConcept[];
  p_posts: PlanCreatePost[];
};
export function planCreateWithItems(
  client: Client,
  args: PlanCreateWithItemsArgs,
): Promise<Result<ProcReturns<'plan_create_with_items'>>> {
  const { p_concepts, p_posts, ...rest } = args;
  return callProc(client, 'plan_create_with_items', {
    ...rest,
    p_concepts: p_concepts as unknown as Json,
    p_posts: p_posts as unknown as Json,
  });
}

export type PlanUpdateArgs = ProcArgs<'plan_update'>;
export function planUpdate(
  client: Client,
  args: PlanUpdateArgs,
): Promise<Result<ProcReturns<'plan_update'>>> {
  return callProc(client, 'plan_update', args);
}

export type PlanShareWithClientArgs = ProcArgs<'plan_share_with_client'>;
export function planShareWithClient(
  client: Client,
  args: PlanShareWithClientArgs,
): Promise<Result<ProcReturns<'plan_share_with_client'>>> {
  return callProc(client, 'plan_share_with_client', args);
}

export type PlanDeleteArgs = ProcArgs<'plan_delete'>;
export function planDelete(
  client: Client,
  args: PlanDeleteArgs,
): Promise<Result<ProcReturns<'plan_delete'>>> {
  return callProc(client, 'plan_delete', args);
}

export type PlanConceptAddArgs = ProcArgs<'plan_concept_add'>;
export function planConceptAdd(
  client: Client,
  args: PlanConceptAddArgs,
): Promise<Result<ProcReturns<'plan_concept_add'>>> {
  return callProc(client, 'plan_concept_add', args);
}

/**
 * plan_concept_edit always writes the date, so it is always sent: null clears
 * it. Files: null keeps the concept's links as they are; an array replaces
 * them (every link is soft-deleted and re-attached), so send one only when the
 * files changed.
 */
export type PlanConceptEditArgs = Omit<
  ProcArgs<'plan_concept_edit'>,
  'p_target_date' | 'p_attachment_version_ids'
> & {
  p_target_date: string | null;
  p_attachment_version_ids: string[] | null;
};
export function planConceptEdit(
  client: Client,
  args: PlanConceptEditArgs,
): Promise<Result<ProcReturns<'plan_concept_edit'>>> {
  // The generated Args type p_target_date as an optional string and
  // p_attachment_version_ids as a string array, but the proc takes null for
  // both (clear the date; keep the files): the one cast that lets null through.
  return callProc(client, 'plan_concept_edit', args as ProcArgs<'plan_concept_edit'>);
}

/** plan_posts_add; p_target_date (optional) puts every added post on that plan day. */
export type PlanPostsAddArgs = ProcArgs<'plan_posts_add'>;
export function planPostsAdd(
  client: Client,
  args: PlanPostsAddArgs,
): Promise<Result<ProcReturns<'plan_posts_add'>>> {
  return callProc(client, 'plan_posts_add', args);
}

export type PlanDraftRowsArgs = ProcArgs<'plan_draft_rows'>;
export function planDraftRows(
  client: Client,
  args: PlanDraftRowsArgs,
): Promise<Result<ProcReturns<'plan_draft_rows'>>> {
  return callProc(client, 'plan_draft_rows', args);
}

export type PlanItemRemoveArgs = ProcArgs<'plan_item_remove'>;
export function planItemRemove(
  client: Client,
  args: PlanItemRemoveArgs,
): Promise<Result<ProcReturns<'plan_item_remove'>>> {
  return callProc(client, 'plan_item_remove', args);
}

/**
 * plan_save: the Plan screen's "Save changes". One call carries the queued
 * edit ops in order (1 to 200): update (title and dates), remove, move (the
 * 5-arg plan_item_move's fields) and reorder. The server runs the existing
 * procs in one transaction, all or nothing; their errors pass through
 * (forbidden_role, invalid_payload, date_outside_plan). The ops are typed
 * here; the generated type only knows Json.
 */
export type PlanSaveOp =
  | { op: 'update'; title: string; starts_on: string; ends_on: string }
  | { op: 'remove'; item_id: string }
  | {
      op: 'move';
      item_id: string;
      target_date: string | null;
      /** The full order of the target day. */
      item_ids: string[];
      keep_reviews: boolean;
    }
  | { op: 'reorder'; item_ids: string[] };
export interface PlanSaveArgs {
  p_plan_id: string;
  p_ops: PlanSaveOp[];
  p_trace_id: string;
}
export function planSave(
  client: Client,
  args: PlanSaveArgs,
): Promise<Result<ProcReturns<'plan_save'>>> {
  return callProc(client, 'plan_save', {
    p_plan_id: args.p_plan_id,
    p_ops: args.p_ops as unknown as Json,
    p_trace_id: args.p_trace_id,
  });
}

export type PlanItemsReorderArgs = ProcArgs<'plan_items_reorder'>;
export function planItemsReorder(
  client: Client,
  args: PlanItemsReorderArgs,
): Promise<Result<ProcReturns<'plan_items_reorder'>>> {
  return callProc(client, 'plan_items_reorder', args);
}

/**
 * plan_item_move, the 5-arg overload only (the 4-arg one stays on live as an
 * unused wrapper): the item's plan day (null = No date; inside the plan's
 * dates else 'date_outside_plan'), the plan's full item order as
 * plan_items_reorder takes it, and p_keep_reviews (on a day change, true keeps
 * the team and client reviews, false resets them). The generated type cannot
 * express the nullable date, so p_target_date is widened here and passed
 * through unchanged.
 */
export interface PlanItemMoveArgs {
  p_item_id: string;
  p_target_date: string | null;
  p_item_ids: string[];
  p_keep_reviews: boolean;
  p_trace_id: string;
}
export function planItemMove(
  client: Client,
  args: PlanItemMoveArgs,
): Promise<Result<ProcReturns<'plan_item_move'>>> {
  return callProc(client, 'plan_item_move', args as ProcArgs<'plan_item_move'>);
}

export type PlanItemReviewArgs = ProcArgs<'plan_item_review'>;
export function planItemReview(
  client: Client,
  args: PlanItemReviewArgs,
): Promise<Result<ProcReturns<'plan_item_review'>>> {
  return callProc(client, 'plan_item_review', args);
}

export type PlanItemCommentCreateArgs = ProcArgs<'plan_item_comment_create'>;
export function planItemCommentCreate(
  client: Client,
  args: PlanItemCommentCreateArgs,
): Promise<Result<ProcReturns<'plan_item_comment_create'>>> {
  return callProc(client, 'plan_item_comment_create', args);
}

export type ChatPlanShareArgs = ProcArgs<'chat_plan_share'>;
export function chatPlanShare(
  client: Client,
  args: ChatPlanShareArgs,
): Promise<Result<ProcReturns<'chat_plan_share'>>> {
  return callProc(client, 'chat_plan_share', args);
}

// --- Workspace rules: storage, Recently deleted, delete workspace -----------

export type AssetRestoreArgs = ProcArgs<'asset_restore'>;
export function assetRestore(
  client: Client,
  args: AssetRestoreArgs,
): Promise<Result<ProcReturns<'asset_restore'>>> {
  return callProc(client, 'asset_restore', args);
}

export type AssetPurgeRequestArgs = ProcArgs<'asset_purge_request'>;
export function assetPurgeRequest(
  client: Client,
  args: AssetPurgeRequestArgs,
): Promise<Result<ProcReturns<'asset_purge_request'>>> {
  return callProc(client, 'asset_purge_request', args);
}

export type WorkspaceDeleteArgs = ProcArgs<'workspace_delete'>;
export function workspaceDelete(
  client: Client,
  args: WorkspaceDeleteArgs,
): Promise<Result<ProcReturns<'workspace_delete'>>> {
  return callProc(client, 'workspace_delete', args);
}

export type WorkspaceStorageArgs = ProcArgs<'workspace_storage'>;
export function workspaceStorage(
  client: Client,
  args: WorkspaceStorageArgs,
): Promise<Result<ProcReturns<'workspace_storage'>>> {
  return callProc(client, 'workspace_storage', args);
}

export type WorkspaceBytesUsedArgs = ProcArgs<'workspace_bytes_used'>;
export function workspaceBytesUsed(
  client: Client,
  args: WorkspaceBytesUsedArgs,
): Promise<Result<ProcReturns<'workspace_bytes_used'>>> {
  return callProc(client, 'workspace_bytes_used', args);
}
