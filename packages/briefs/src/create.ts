// createBrief: the client-facing write path for a new brief. It shapes a small
// set of named, typed fields into the jsonb payload that the SECURITY DEFINER
// public.brief_create proc expects, then delegates to the @srtdio/rpc wrapper.
// The proc is the single insert authority (it enforces brief.create capability
// and active membership); this layer never re-checks who may create.
//
// Briefs are read-only after creation. initial_comment_body is therefore NOT a
// brief column: when supplied it opens the brief's comment thread with one
// brief-anchored root comment via public.comment_create, in a second call.

import {
  briefCreate,
  commentCreate,
  type Client,
  type CommentCreateArgs,
  type Result,
} from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';

export interface CreateBriefInput {
  /** Workspace the brief belongs to. RLS + the proc gate membership. */
  workspaceId: string;
  /** Required. 1 to 200 chars (enforced by the table CHECK via the proc). */
  title: string;
  /** Required. 1 to 5000 chars. */
  objective: string;
  /** Optional. One of: text / single_image / carousel / video / link. */
  formatRequested?: string;
  /** Optional free text. */
  brandRequirements?: string;
  /** Optional indicative date, ISO `YYYY-MM-DD`. */
  targetDate?: string;
  /** Optional jsonb blob of reference links. */
  referenceLinks?: Json;
  /**
   * Optional, ordered list of asset_version ids (any kind: image / video / pdf /
   * doc / link) to attach to the brief at creation. Position is array order.
   * Briefs are read-only after creation, so this is the only attach point.
   */
  attachmentAssetVersionIds?: string[];
  /** Optional. When non-empty, posts the brief's opening (root) comment. */
  initialCommentBody?: string;
}

export interface CreateBriefResult {
  /** Id of the created brief. */
  id: string;
  /** Id of the opening comment when initialCommentBody was given, else null. */
  commentId: string | null;
}

export async function createBrief(
  client: Client,
  input: CreateBriefInput,
  traceId: string,
): Promise<Result<CreateBriefResult>> {
  // Optional fields are omitted rather than sent as null so the proc's column
  // defaults and COALESCE branches apply. created_via is always 'app':
  // 'email_forward' is reserved for future ingestion, never set from this path.
  const payload: Record<string, Json | undefined> = {
    title: input.title,
    objective: input.objective,
    created_via: 'app',
  };
  if (input.formatRequested !== undefined) payload.format_requested = input.formatRequested;
  if (input.brandRequirements !== undefined) payload.brand_requirements = input.brandRequirements;
  if (input.targetDate !== undefined) payload.target_date = input.targetDate;
  if (input.referenceLinks !== undefined) payload.reference_links = input.referenceLinks;
  if (input.attachmentAssetVersionIds !== undefined)
    payload.attachment_asset_version_ids = input.attachmentAssetVersionIds;

  const created = await briefCreate(client, {
    p_workspace_id: input.workspaceId,
    p_payload: payload as Json,
    p_trace_id: traceId,
  });
  if (!created.ok) return created;
  const id = created.data;

  if (input.initialCommentBody !== undefined && input.initialCommentBody.length > 0) {
    const args: CommentCreateArgs = {
      p_workspace_id: input.workspaceId,
      p_entity_type: 'brief',
      p_entity_id: id,
      // Root comment on the brief: no parent. The generated arg type narrows the
      // proc's nullable parent_comment_id to `string`; types regen is out of
      // scope here, so the null root parent is asserted at this single point.
      p_parent_comment_id: null as unknown as string,
      p_body: input.initialCommentBody,
      p_mentions: null,
      p_attachment_asset_ids: [],
      p_is_decision: false,
      p_trace_id: traceId,
    };
    const comment = await commentCreate(client, args);
    if (!comment.ok) return comment;
    return { ok: true, data: { id, commentId: comment.data } };
  }

  return { ok: true, data: { id, commentId: null } };
}
