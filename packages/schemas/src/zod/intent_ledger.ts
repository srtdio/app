import { z } from 'zod';

export const IntentLedgerSchema = z.object({
  id: z.string().uuid(),
  operator_user_id: z.string().uuid(),
  action: z.string(),
  target_type: z.enum(['workspace', 'user', 'flag', 'deploy']).nullable(),
  target_id: z.string().nullable(),
  payload: z.unknown(),
  status: z.enum(['pending', 'committed', 'failed', 'expired']),
  reason_category: z.string().nullable(),
  reason_text: z.string().nullable(),
  ticket_id: z.string().nullable(),
  created_at: z.string(),
  committed_at: z.string().nullable(),
  expires_at: z.string(),
  trace_id: z.string().uuid(),
});

export type IntentLedger = z.infer<typeof IntentLedgerSchema>;
