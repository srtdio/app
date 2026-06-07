import { z } from 'zod';

export const PostSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  title: z.string(),
  caption: z.string().nullable(),
  bucket_id: z.string().uuid().nullable(),
  owner_user_id: z.string().uuid(),
  platform: z.enum(['linkedin', 'x', 'instagram', 'facebook', 'threads']),
  format: z.enum(['text', 'single_image', 'carousel', 'video', 'link']),
  stage: z.enum(['draft', 'review', 'approved', 'parked', 'rejected']),
  target_date: z.string().nullable(),
  origin: z.enum(['manual', 'brief']),
  brief_id: z.string().uuid().nullable(),
  row_version: z.number().int(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Post = z.infer<typeof PostSchema>;
