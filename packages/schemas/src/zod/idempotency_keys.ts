import { z } from 'zod';

export const IdempotencyKeySchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  request_hash: z.string(),
  response_status: z.number().nullable(),
  response_body: z.unknown().nullable(),
  status: z.enum(['in_flight', 'completed']),
  workspace_id: z.string().uuid().nullable(),
  user_id: z.string().uuid().nullable(),
  trace_id: z.string().uuid(),
  expires_at: z.string(),
  created_at: z.string(),
});

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
