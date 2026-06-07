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

export type CommentCreateArgs = ProcArgs<'comment_create'>;
export function commentCreate(
  client: Client,
  args: CommentCreateArgs,
): Promise<Result<ProcReturns<'comment_create'>>> {
  return callProc(client, 'comment_create', args);
}

export type WorkspaceCreateArgs = ProcArgs<'workspace_create'>;
export function workspaceCreate(
  client: Client,
  args: WorkspaceCreateArgs,
): Promise<Result<ProcReturns<'workspace_create'>>> {
  return callProc(client, 'workspace_create', args);
}
