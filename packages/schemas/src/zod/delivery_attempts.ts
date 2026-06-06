import { z } from 'zod';

export const DeliveryAttemptSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid().nullable(),
  user_id: z.string().uuid().nullable(),
  channel: z.enum(['email', 'push']),
  template_key: z.string(),
  provider: z.enum(['resend', 'fcm', 'apns', 'web_push']),
  provider_message_id: z.string().nullable(),
  status: z.enum(['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed']),
  error: z.string().nullable(),
  sent_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  bounced_at: z.string().nullable(),
  created_at: z.string(),
  email_thread_id: z.string().uuid().nullable(),
});

export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;
