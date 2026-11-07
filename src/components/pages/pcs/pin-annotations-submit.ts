// The write side of an anchored comment (a photo pin or a caption highlight),
// kept out of PostDetailPage so the RPC sequence is unit-testable with a fake
// client. Comment first, annotation second, both on the one trace the caller
// minted for the tap (sent as each proc's explicit p_trace_id).
//
// A client's comment on a post is a checkpoint: comment_batch_create with ONE
// point, whose jsonb reply is [{ id, seq }] (seq = the new ledger_seq), so the
// pin is numbered like the checkpoint it is. comment_create refuses a client's
// top-level comment (forbidden_role). Everyone else (the agency) writes a plain
// comment_create; that pin draws as the ink dot with no number. The annotation
// is annotation_create with p_comment_id = the new comment's id.

import { createComment } from '@srtdio/comments';
import { annotationCreate } from '@srtdio/posts';
import type { Client } from '@srtdio/rpc';
import { runCreateCommentBatch } from '@/components/comments/Comments';

/** The comment an annotation anchors to: its id and, for a checkpoint, its number. */
export type AnchoredComment =
  | { ok: true; commentId: string; seq: number | null }
  | { ok: false; message: string };

export interface AnchoredCommentInput {
  /** The viewer's workspace role is client: the comment is a checkpoint. */
  asCheckpoint: boolean;
  workspaceId: string;
  postId: string;
  body: string;
  traceId: string;
}

/** Create the comment an annotation anchors to (checkpoint for a client). */
export async function createAnchoredComment(
  client: Client,
  input: AnchoredCommentInput,
): Promise<AnchoredComment> {
  if (input.asCheckpoint) {
    const batch = await runCreateCommentBatch(client, {
      workspaceId: input.workspaceId,
      postId: input.postId,
      points: [{ body: input.body }],
      traceId: input.traceId,
    });
    if (!batch.ok) return { ok: false, message: batch.error.message };
    const first = batch.data[0];
    if (first === undefined) return { ok: false, message: 'invalid_payload' };
    return { ok: true, commentId: first.id, seq: first.seq };
  }
  const result = await createComment(client, {
    workspace_id: input.workspaceId,
    entity_type: 'post',
    entity_id: input.postId,
    body: input.body,
    trace_id: input.traceId,
  });
  if (!result.ok) return { ok: false, message: result.error.message };
  return { ok: true, commentId: result.data, seq: null };
}

export interface PinSubmitInput extends AnchoredCommentInput {
  postVersionId: string;
  assetAttachmentId: string;
  /** Normalised [0,1] point on the original image. */
  x: number;
  y: number;
}

/**
 * The outcome of a pin submit. comment_failed: nothing was written (the text
 * stays in the sheet). annotation_failed: the comment landed but the pin did
 * not, so it stays a plain comment. ok: both landed.
 */
export type PinSubmitResult =
  | { status: 'comment_failed'; message: string }
  | { status: 'annotation_failed'; commentId: string; seq: number | null; message: string }
  | { status: 'ok'; commentId: string; seq: number | null };

/** Comment (checkpoint for a client), then the image_pin annotation on it. */
export async function submitPin(client: Client, input: PinSubmitInput): Promise<PinSubmitResult> {
  const comment = await createAnchoredComment(client, input);
  if (!comment.ok) return { status: 'comment_failed', message: comment.message };
  const annotation = await annotationCreate(client, {
    kind: 'image_pin',
    postId: input.postId,
    postVersionId: input.postVersionId,
    commentId: comment.commentId,
    assetAttachmentId: input.assetAttachmentId,
    imageX: input.x,
    imageY: input.y,
    traceId: input.traceId,
  });
  if (!annotation.ok) {
    return {
      status: 'annotation_failed',
      commentId: comment.commentId,
      seq: comment.seq,
      message: annotation.error.message,
    };
  }
  return { status: 'ok', commentId: comment.commentId, seq: comment.seq };
}
