import { z } from 'zod';

export const WebhookProcessingAttemptSchema = z.object({
  id: z.string().uuid(),
  webhook_event_id: z.string().uuid(),
  attempt_number: z.number().int(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  outcome: z.string().nullable(),
  error: z.string().nullable(),
  trace_id: z.string().uuid(),
});

export type WebhookProcessingAttempt = z.infer<typeof WebhookProcessingAttemptSchema>;
