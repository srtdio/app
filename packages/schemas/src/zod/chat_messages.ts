import { z } from 'zod';

export const ChatMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  workspace_id: z.string().uuid(),
  sender_user_id: z.string().uuid().nullable(),
  body: z.string().nullable(),
  mentions: z.unknown().nullable(),
  attachment_asset_ids: z.array(z.string().uuid()).nullable(),
  agora_event_id: z.string(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
