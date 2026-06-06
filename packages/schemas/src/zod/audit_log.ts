import { z } from 'zod';

export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid().nullable(),
  actor_user_id: z.string().uuid().nullable(),
  on_behalf_of: z.string().uuid().nullable(),
  impersonation_session_id: z.string().uuid().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  payload: z.unknown().nullable(),
  outcome: z.enum(['success', 'failure']),
  error_code: z.string().nullable(),
  trace_id: z.string().uuid(),
  ip_subnet: z.string().nullable(),
  created_at: z.string(),
});

export type AuditLog = z.infer<typeof AuditLogSchema>;
