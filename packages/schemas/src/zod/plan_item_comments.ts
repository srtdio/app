import { z } from 'zod';

export const PlanItemCommentSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  item_id: z.string().uuid(),
  author_user_id: z.string().uuid().nullable(),
  body: z.string().min(1).max(5000),
  visibility: z.enum(['everyone', 'team']),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

export type PlanItemComment = z.infer<typeof PlanItemCommentSchema>;
