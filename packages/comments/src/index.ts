// @srtdio/comments: the read + create layer for the comments primitive.
//
//   * createComment validates @[user_id] mentions against active workspace
//     membership, then writes through the public.comment_create SECURITY DEFINER
//     proc (via the @srtdio/rpc wrapper). It never writes the comments table
//     directly; the authenticated role has no INSERT policy.
//   * listComments and searchComments are direct, RLS-scoped SELECTs as the
//     authenticated caller. RLS confines every read to the caller's workspaces;
//     the explicit workspace_id filter also pins the query to the entity/FTS
//     indexes.
//
// trace_id is always an explicit parameter, never inferred. Edit, delete,
// is_decision toggle, reactions and inbox fan-out are out of scope here.

import type { Database, Json } from '@srtdio/schemas';
import {
  commentCreate,
  type Client,
  type CommentCreateArgs,
  type DomainError,
  type DomainErrorCode,
} from '@srtdio/rpc';
import { parseMentions } from './mentions';

export { parseMentions } from './mentions';
export type { Client } from '@srtdio/rpc';

/** A persisted comment row, exactly as stored. */
export type CommentRow = Database['public']['Tables']['comments']['Row'];

/** The two entity kinds a comment may anchor to in the MVP. */
export type CommentEntityType = 'post' | 'brief';

/** Page size for both list and search reads. Fixed; not caller-tunable. */
export const PAGE_SIZE = 50;

/**
 * A failed comment operation. Extends the proc's domain errors with the one
 * failure that is owned by this layer rather than the database: a mention that
 * does not resolve to an active workspace member.
 */
export interface CommentError {
  code: DomainErrorCode | 'invalid_mention';
  message: string;
  /** Present only when code is 'invalid_mention': the offending user ids. */
  invalidMentions?: string[];
}

export type CommentResult<T> = { ok: true; data: T } | { ok: false; error: CommentError };

function fromDomainError(error: DomainError): CommentError {
  return { code: error.code, message: error.message };
}

function transportError(message: string): CommentError {
  return { code: 'unknown', message };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateCommentInput {
  workspace_id: string;
  entity_type: CommentEntityType;
  entity_id: string;
  parent_comment_id?: string | null;
  body: string;
  /** Optional explicit mentions; unioned with those parsed from the body. */
  mentions?: string[];
  attachment_asset_ids?: string[];
  is_decision?: boolean;
  trace_id: string;
}

/**
 * Validate that every id in `candidates` is an active member of `workspaceId`,
 * read through the caller's RLS-scoped view of workspace_members. Returns the
 * ids that are not active members (empty when all resolve).
 */
async function invalidMentions(
  client: Client,
  workspaceId: string,
  candidates: readonly string[],
): Promise<{ ok: true; invalid: string[] } | { ok: false; error: CommentError }> {
  if (candidates.length === 0) return { ok: true, invalid: [] };
  const { data, error } = await client
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .in('user_id', candidates);
  if (error) return { ok: false, error: transportError(error.message) };
  const active = new Set((data ?? []).map((row) => row.user_id));
  return { ok: true, invalid: candidates.filter((id) => !active.has(id)) };
}

/**
 * Create a comment. Mentions are derived from the body's @[user_id] tokens,
 * unioned with any explicitly supplied ids, and every one must resolve to an
 * active workspace member or the call is rejected before the proc runs.
 */
export async function createComment(
  client: Client,
  input: CreateCommentInput,
): Promise<CommentResult<string>> {
  const mentions = Array.from(new Set([...parseMentions(input.body), ...(input.mentions ?? [])]));

  const check = await invalidMentions(client, input.workspace_id, mentions);
  if (!check.ok) return { ok: false, error: check.error };
  if (check.invalid.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_mention',
        message: `mentions are not active workspace members: ${check.invalid.join(', ')}`,
        invalidMentions: check.invalid,
      },
    };
  }

  const args: CommentCreateArgs = {
    p_workspace_id: input.workspace_id,
    p_entity_type: input.entity_type,
    p_entity_id: input.entity_id,
    // The generated arg type is non-nullable, but the proc accepts NULL for a
    // top-level (unthreaded) comment.
    p_parent_comment_id: (input.parent_comment_id ?? null) as unknown as string,
    p_body: input.body,
    p_mentions: (mentions.length > 0 ? mentions : null) as Json,
    p_attachment_asset_ids: input.attachment_asset_ids ?? [],
    p_is_decision: input.is_decision ?? false,
    p_trace_id: input.trace_id,
  };

  const result = await commentCreate(client, args);
  if (!result.ok) return { ok: false, error: fromDomainError(result.error) };
  return { ok: true, data: result.data };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListCommentsInput {
  workspace_id: string;
  entity_type: CommentEntityType;
  entity_id: string;
  /** Filter to decisions (true) or non-decisions (false); omit for all. */
  is_decision?: boolean;
  /** Filter to a single author_user_id. */
  author?: string;
  /** Zero-based page index; PAGE_SIZE rows per page. */
  page?: number;
}

/**
 * List the live comments on one entity, newest first, one page at a time.
 * Soft-deleted rows are excluded. RLS guarantees the caller only ever sees rows
 * in workspaces they are an active member of.
 */
export async function listComments(
  client: Client,
  input: ListCommentsInput,
): Promise<CommentResult<CommentRow[]>> {
  const page = Math.max(0, input.page ?? 0);
  const start = page * PAGE_SIZE;

  let query = client
    .from('comments')
    .select('*')
    .eq('workspace_id', input.workspace_id)
    .eq('entity_type', input.entity_type)
    .eq('entity_id', input.entity_id)
    .is('deleted_at', null);

  if (input.is_decision !== undefined) query = query.eq('is_decision', input.is_decision);
  if (input.author !== undefined) query = query.eq('author_user_id', input.author);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(start, start + PAGE_SIZE - 1);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data ?? [] };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchCommentsInput {
  workspace_id: string;
  /** Free-text query; matched against the body via the english FTS index. */
  query: string;
  /** Zero-based page index; PAGE_SIZE rows per page. */
  page?: number;
}

/**
 * Full-text search comment bodies within one workspace, using the existing
 * english tsvector index (comments_body_fts_idx). Results are paginated and
 * ordered newest first; true ts_rank ordering would require a SECURITY DEFINER
 * proc, which is out of scope for this read layer.
 */
export async function searchComments(
  client: Client,
  input: SearchCommentsInput,
): Promise<CommentResult<CommentRow[]>> {
  const page = Math.max(0, input.page ?? 0);
  const start = page * PAGE_SIZE;

  const { data, error } = await client
    .from('comments')
    .select('*')
    .eq('workspace_id', input.workspace_id)
    .is('deleted_at', null)
    .textSearch('body', input.query, { type: 'plain', config: 'english' })
    .order('created_at', { ascending: false })
    .range(start, start + PAGE_SIZE - 1);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data ?? [] };
}
