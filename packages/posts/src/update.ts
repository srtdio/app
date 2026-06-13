// postUpdate: the client-facing path for editing a post's metadata via
// public.post_update. The proc applies a partial update keyed on payload
// PRESENCE: a key absent from p_payload is left untouched, a key present with a
// value is written, and (for the nullable columns) a key present as null clears
// the column. So this wrapper sends ONLY the keys the caller explicitly
// provided, never widening an edit into an accidental overwrite of unset fields.
//
// ownerUserId is the post's owner, never the acting identity; the actor is
// always auth.uid() server-side. ownerUserId and targetDate accept an explicit
// null to clear them; omit them entirely to leave them as they are.

import {
  postUpdate as postUpdateRpc,
  type Client,
  type DomainError,
  type Result,
} from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { z } from 'zod';
import { resolveTraceId } from './trace';

/**
 * The update payload, validated before it leaves the client. Every field except
 * postId is optional; the nullable fields additionally accept an explicit null
 * to clear the column. Key presence is what the proc acts on, so undefined and
 * a missing key are equivalent (the field is left untouched).
 */
export const PostUpdateSchema = z.object({
  postId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  bucketId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  targetDate: z.string().nullable().optional(),
});

export type PostUpdateInput = z.infer<typeof PostUpdateSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Update a post's metadata via public.post_update. Only keys the caller
 * explicitly provided are placed in p_payload, so unset fields are never
 * overwritten. ownerUserId and targetDate may be passed as null to clear them.
 * Client-side Zod failures surface as the same `invalid_payload` domain error
 * the proc raises.
 */
export async function postUpdate(
  client: Client,
  input: PostUpdateInput,
  traceId?: string,
): Promise<Result<string>> {
  const parsed = PostUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  // Keys are snake_case to match the columns post_update reads. Only the keys
  // the caller supplied are included; the nullable ones keep an explicit null so
  // the proc clears the column rather than leaving it untouched.
  const payload: Record<string, Json> = {};
  if (p.title !== undefined) payload.title = p.title;
  if (p.bucketId !== undefined) payload.bucket_id = p.bucketId;
  if ('ownerUserId' in input) payload.owner_user_id = p.ownerUserId ?? null;
  if ('targetDate' in input) payload.target_date = p.targetDate ?? null;

  return postUpdateRpc(client, {
    p_post_id: p.postId,
    p_payload: payload as Json,
    p_trace_id: resolveTraceId(traceId),
  });
}
