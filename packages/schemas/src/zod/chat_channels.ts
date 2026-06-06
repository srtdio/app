import { z } from 'zod';

export const ChatChannelSchema = z.object({
  channel_id: z.string(),
  workspace_id: z.string().uuid(),
  channel_type: z.enum(['dm', 'group']),
  entity_id: z.string().uuid().nullable(),
  dm_user_a: z.string().uuid().nullable(),
  dm_user_b: z.string().uuid().nullable(),
  last_synced_at: z.string().nullable(),
  created_at: z.string(),
});

export type ChatChannel = z.infer<typeof ChatChannelSchema>;
