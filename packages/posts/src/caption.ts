// postCaptionUpdate: write a new caption for a post via
// public.post_caption_update. The proc auto-versions the post (a fresh
// post_version snapshot) as part of the same transaction, so callers never call
// postVersionCreate alongside it. This wrapper validates the shape and threads
// the trace_id; the proc owns the capability gate and the versioning.
//
// The actor is always auth.uid() server-side; no caller-supplied actor id is
// ever sent.

import {
  postCaptionUpdate as postCaptionUpdateRpc,
  type Client,
  type DomainError,
  type Result,
} from '@srtdio/rpc';
import { z } from 'zod';
import { resolveTraceId } from './trace';

export const PostCaptionUpdateSchema = z.object({
  postId: z.string().uuid(),
  caption: z.string(),
});

export type PostCaptionUpdateInput = z.infer<typeof PostCaptionUpdateSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Update a post's caption (and auto-version it) via public.post_caption_update.
 * Client-side Zod failures surface as the same `invalid_payload` domain error
 * the proc raises.
 */
export async function postCaptionUpdate(
  client: Client,
  input: PostCaptionUpdateInput,
  traceId?: string,
): Promise<Result<string>> {
  const parsed = PostCaptionUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  return postCaptionUpdateRpc(client, {
    p_post_id: p.postId,
    p_caption: p.caption,
    p_trace_id: resolveTraceId(traceId),
  });
}
