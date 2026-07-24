// deleteSubPoint: hard-path soft-delete of a checkpoint SUB-POINT via the new
// public.comment_delete proc. Distinct from deleteComment (./delete), which
// wraps comment_soft_delete for ordinary comments: comment_delete is author-only
// AND sub-point-only, raising invalid_payload on a checkpoint or a top-level
// comment. The wrapper is named for that narrower target because the plain
// deleteComment export is already taken by the comment_soft_delete path that
// Comments.tsx depends on. Shape mirrors editComment: (client, input, traceId),
// Zod-validated, trace threaded explicitly. The actor is always auth.uid()
// server-side; no caller-supplied actor id is ever sent.

import { commentDelete, type Client, type DomainError, type Result } from '@srtdio/rpc';
import { z } from 'zod';

export const DeleteSubPointSchema = z.object({
  commentId: z.string().uuid(),
});

export type DeleteSubPointInput = z.infer<typeof DeleteSubPointSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Soft-delete a sub-point via public.comment_delete. Client-side Zod failures
 * surface as the same `invalid_payload` domain error the proc raises, so callers
 * branch on one shape regardless of where the rejection happened. The proc
 * returns void, so the data on success is undefined.
 */
export async function deleteSubPoint(
  client: Client,
  input: DeleteSubPointInput,
  traceId: string,
): Promise<Result<undefined>> {
  const parsed = DeleteSubPointSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  return commentDelete(client, {
    p_comment_id: p.commentId,
    p_trace_id: traceId,
  });
}
