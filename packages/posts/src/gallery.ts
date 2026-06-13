// gallerySet: replace a post's ordered asset gallery via public.gallery_set. The
// supplied asset_version_ids become the gallery in array order; an empty array
// clears it. The proc auto-versions the post (a fresh post_version snapshot) in
// the same transaction, so callers never call postVersionCreate alongside it.
// This wrapper validates the shape and threads the trace_id; the proc owns the
// capability gate, the FK integrity, and the versioning.
//
// The actor is always auth.uid() server-side; no caller-supplied actor id is
// ever sent.

import {
  gallerySet as gallerySetRpc,
  type Client,
  type DomainError,
  type Result,
} from '@srtdio/rpc';
import { z } from 'zod';
import { resolveTraceId } from './trace';

export const GallerySetSchema = z.object({
  postId: z.string().uuid(),
  assetVersionIds: z.array(z.string().uuid()),
});

export type GallerySetInput = z.infer<typeof GallerySetSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Set a post's ordered asset gallery (and auto-version it) via
 * public.gallery_set. An empty assetVersionIds array clears the gallery.
 * Client-side Zod failures surface as the same `invalid_payload` domain error
 * the proc raises.
 */
export async function gallerySet(
  client: Client,
  input: GallerySetInput,
  traceId?: string,
): Promise<Result<string>> {
  const parsed = GallerySetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  return gallerySetRpc(client, {
    p_post_id: p.postId,
    p_asset_version_ids: p.assetVersionIds,
    p_trace_id: resolveTraceId(traceId),
  });
}
