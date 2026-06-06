import { z } from 'zod';

export const CockpitAccessLogSchema = z.object({
  id: z.string().uuid(),
  operator_user_id: z.string().uuid(),
  route: z.string(),
  workspace_id: z.string().uuid().nullable(),
  session_id: z.string().uuid(),
  accessed_at: z.string(),
  trace_id: z.string().uuid(),
});

export type CockpitAccessLog = z.infer<typeof CockpitAccessLogSchema>;
