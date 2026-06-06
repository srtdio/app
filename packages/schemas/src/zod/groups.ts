import { z } from 'zod';

export const GroupSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Group = z.infer<typeof GroupSchema>;
