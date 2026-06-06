import { z } from 'zod';

export const WorkspaceBucketSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string(),
  color_hex: z.string(),
  position: z.number().int(),
  archived: z.boolean(),
  created_at: z.string(),
  target_month: z.number().int(),
});

export type WorkspaceBucket = z.infer<typeof WorkspaceBucketSchema>;
