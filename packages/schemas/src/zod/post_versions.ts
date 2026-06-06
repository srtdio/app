import { z } from 'zod';

export const PostVersionSchema = z.object({
  id: z.string().uuid(),
  post_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  version_number: z.number().int(),
  snapshot: z.unknown(),
  created_by: z.string().uuid(),
  created_at: z.string(),
});

export type PostVersion = z.infer<typeof PostVersionSchema>;
