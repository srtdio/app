import { z } from 'zod';

export const CockpitProcedureAllowlistSchema = z.object({
  procedure_name: z.string(),
  description: z.string(),
  risk_tier: z.enum(['tap', 'medium', 'nuclear']),
  added_at: z.string(),
  added_by: z.string().uuid(),
});

export type CockpitProcedureAllowlist = z.infer<typeof CockpitProcedureAllowlistSchema>;
