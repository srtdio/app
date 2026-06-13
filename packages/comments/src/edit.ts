// editComment: rewrite the body of a live comment via public.comment_edit. The
// proc is author-only (it raises forbidden_role for anyone but the original
// author) and refuses a soft-deleted comment; this wrapper validates the shape
// and threads the trace_id. The actor is always auth.uid() server-side; no
// caller-supplied actor id is ever sent.

import { commentEdit, type Client, type DomainError, type Result } from '@srtdio/rpc';
import { z } from 'zod';

export const EditCommentSchema = z.object({
  commentId: z.string().uuid(),
  body: z.string().min(1),
});

export type EditCommentInput = z.infer<typeof EditCommentSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Edit a comment's body via public.comment_edit. Client-side Zod failures
 * surface as the same `invalid_payload` domain error the proc raises, so callers
 * branch on one shape regardless of where the rejection happened.
 */
export async function editComment(
  client: Client,
  input: EditCommentInput,
  traceId: string,
): Promise<Result<string>> {
  const parsed = EditCommentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  return commentEdit(client, {
    p_comment_id: p.commentId,
    p_body: p.body,
    p_trace_id: traceId,
  });
}
