// annotationCreate: anchor a comment to a precise spot on a post version, via
// public.annotation_create. Two kinds, discriminated on `kind`:
//   * caption_span pins to a [captionStart, captionEnd) range in the caption;
//     the image coordinates are sent null.
//   * image_pin pins to a normalised (imageX, imageY) point in [0,1] on an
//     attached asset; the caption range is sent null.
// Both always carry the comment_id they belong to. The proc owns immutability
// (post_annotations has no deleted_at) and the FK integrity; this wrapper
// validates the shape and shapes the call.

import {
  annotationCreate as annotationCreateRpc,
  type AnnotationCreateArgs,
  type Client,
  type DomainError,
  type Result,
} from '@srtdio/rpc';
import { z } from 'zod';
import { resolveTraceId } from './trace';

const captionSpan = z.object({
  kind: z.literal('caption_span'),
  postId: z.string().uuid(),
  postVersionId: z.string().uuid(),
  commentId: z.string().uuid(),
  captionStart: z.number().int().nonnegative(),
  captionEnd: z.number().int().nonnegative(),
  traceId: z.string().optional(),
});

const imagePin = z.object({
  kind: z.literal('image_pin'),
  postId: z.string().uuid(),
  postVersionId: z.string().uuid(),
  commentId: z.string().uuid(),
  assetAttachmentId: z.string().uuid(),
  imageX: z.number().min(0).max(1),
  imageY: z.number().min(0).max(1),
  traceId: z.string().optional(),
});

export const AnnotationCreateSchema = z.discriminatedUnion('kind', [captionSpan, imagePin]);

export type AnnotationCreateInput = z.infer<typeof AnnotationCreateSchema>;

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Create a post annotation. The kind decides which fields are required; the
 * other family of fields is sent null. The generated proc arg type is
 * non-nullable, but the proc accepts NULL for the inapplicable coordinates, so
 * the nulls are asserted at this single point. Client-side Zod failures surface
 * as the same `invalid_payload` domain error the proc raises.
 */
export async function annotationCreate(
  client: Client,
  input: AnnotationCreateInput,
): Promise<Result<string>> {
  const parsed = AnnotationCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const a = parsed.data;

  const captionStart = a.kind === 'caption_span' ? a.captionStart : null;
  const captionEnd = a.kind === 'caption_span' ? a.captionEnd : null;
  const assetAttachmentId = a.kind === 'image_pin' ? a.assetAttachmentId : null;
  const imageX = a.kind === 'image_pin' ? a.imageX : null;
  const imageY = a.kind === 'image_pin' ? a.imageY : null;

  const args: AnnotationCreateArgs = {
    p_post_id: a.postId,
    p_post_version_id: a.postVersionId,
    p_kind: a.kind,
    p_caption_start: captionStart as unknown as number,
    p_caption_end: captionEnd as unknown as number,
    p_asset_attachment_id: assetAttachmentId as unknown as string,
    p_image_x: imageX as unknown as number,
    p_image_y: imageY as unknown as number,
    p_comment_id: a.commentId,
    p_trace_id: resolveTraceId(a.traceId),
  };

  return annotationCreateRpc(client, args);
}
