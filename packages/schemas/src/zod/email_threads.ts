import { z } from 'zod';

export const EmailThreadSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  root_type: z.string(),
  root_id: z.string().uuid(),
  message_id: z.string(),
  subject: z.string(),
  created_at: z.string(),
  last_sent_at: z.string().nullable(),
});

export type EmailThread = z.infer<typeof EmailThreadSchema>;
