// deleteComment: soft-delete a live comment via public.comment_soft_delete. The
// proc is author-only (it raises forbidden_role for anyone but the original
// author) and sets deleted_at rather than removing the row, so the thread keeps
// its shape. This wrapper validates the shape and threads the trace_id. The
// actor is always auth.uid() server-side; no caller-supplied actor id is sent.

import { commentSoftDelete, type Client, type DomainError, type Result } from '@srtdio/rpc';
import { z } from 'zod';

export const DeleteCommentSchema = z.object({
  commentId: z.string().uuid(),
});

export type DeleteCommentInput = z.infer<typeof DeleteCommentSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Soft-delete a comment via public.comment_soft_delete. Client-side Zod failures
 * surface as the same `invalid_payload` domain error the proc raises.
 */
export async function deleteComment(
  client: Client,
  input: DeleteCommentInput,
  traceId: string,
): Promise<Result<string>> {
  const parsed = DeleteCommentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  return commentSoftDelete(client, {
    p_comment_id: p.commentId,
    p_trace_id: traceId,
  });
}
