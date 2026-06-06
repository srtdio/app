import { z } from 'zod';

export const WebhookEventSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(['stripe', 'resend', 'linkedin']),
  source_event_id: z.string(),
  event_type: z.string(),
  workspace_id: z.string().uuid().nullable(),
  signature_verified: z.boolean(),
  raw_payload: z.unknown(),
  received_at: z.string(),
});

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
