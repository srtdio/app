import { z } from 'zod';

export const BriefSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  title: z.string(),
  objective: z.string(),
  format_requested: z.string().nullable(),
  brand_requirements: z.string().nullable(),
  target_date: z.string().nullable(),
  reference_links: z.unknown().nullable(),
  status: z.enum(['open', 'closed']),
  closed_at: z.string().nullable(),
  closed_by: z.string().uuid().nullable(),
  created_by: z.string().uuid(),
  created_via: z.string(),
  row_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Brief = z.infer<typeof BriefSchema>;
