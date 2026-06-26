// resolveComment: toggle the thread-level resolved state on a root comment via
// public.comment_resolve. The proc is thread-level (a reply raises invalid_payload)
// and open to any active workspace member; resolving stamps resolved_at/resolved_by
// and notifies the other thread authors, reopening clears the state silently. This
// wrapper validates the shape and threads the trace_id. The actor is always
// auth.uid() server-side; no caller-supplied actor id is ever sent.

import { commentResolve, type Client, type DomainError, type Result } from '@srtdio/rpc';
import { z } from 'zod';

export const ResolveCommentSchema = z.object({
  commentId: z.string().uuid(),
  resolved: z.boolean(),
});

export type ResolveCommentInput = z.infer<typeof ResolveCommentSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Resolve (resolved=true) or reopen (resolved=false) a comment thread via
 * public.comment_resolve. Client-side Zod failures surface as the same
 * `invalid_payload` domain error the proc raises, so callers branch on one shape.
 * The proc returns void, so the data on success is undefined.
 */
export async function resolveComment(
  client: Client,
  input: ResolveCommentInput,
  traceId: string,
): Promise<Result<undefined>> {
  const parsed = ResolveCommentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  return commentResolve(client, {
    p_comment_id: p.commentId,
    p_resolved: p.resolved,
    p_trace_id: traceId,
  });
}
