import { z } from 'zod';

export const PostAnnotationSchema = z.object({
  id: z.string().uuid(),
  post_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  post_version_id: z.string().uuid(),
  kind: z.string(),
  caption_start: z.number().int().nullable(),
  caption_end: z.number().int().nullable(),
  asset_attachment_id: z.string().uuid().nullable(),
  image_x: z.number().nullable(),
  image_y: z.number().nullable(),
  comment_id: z.string().uuid(),
  created_at: z.string(),
});

export type PostAnnotation = z.infer<typeof PostAnnotationSchema>;
