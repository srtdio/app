import { z } from 'zod';

export const PlanSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  starts_on: z.string(),
  ends_on: z.string(),
  audience: z.enum(['team', 'client']),
  shared_with_client_at: z.string().nullable(),
  shared_with_client_by: z.string().uuid().nullable(),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Plan = z.infer<typeof PlanSchema>;
