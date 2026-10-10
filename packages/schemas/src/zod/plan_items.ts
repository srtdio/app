import { z } from 'zod';

export const PlanItemSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  plan_id: z.string().uuid(),
  kind: z.enum(['concept', 'post']),
  position: z.number().int(),
  title: z.string().min(1).max(200).nullable(),
  description: z.string().max(5000).nullable(),
  post_id: z.string().uuid().nullable(),
  target_date: z.string().nullable(),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type PlanItem = z.infer<typeof PlanItemSchema>;
