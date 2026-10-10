import { z } from 'zod';

export const PlanItemReviewSchema = z.object({
  item_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  side: z.enum(['team', 'client']),
  status: z.enum(['waiting', 'approved', 'changes']),
  reviewed_by: z.string().uuid().nullable(),
  reviewed_at: z.string(),
});

export type PlanItemReview = z.infer<typeof PlanItemReviewSchema>;
