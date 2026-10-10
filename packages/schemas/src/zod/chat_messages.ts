import { z } from 'zod';

export const ChatMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  workspace_id: z.string().uuid(),
  sender_user_id: z.string().uuid().nullable(),
  body: z.string().nullable(),
  mentions: z.unknown().nullable(),
  attachment_asset_ids: z.array(z.string().uuid()).nullable(),
  shared_post_ids: z.array(z.string().uuid()).nullable(),
  shared_brief_ids: z.array(z.string().uuid()).nullable(),
  shared_plan_ids: z.array(z.string().uuid()).nullable(),
  reply_to_message_id: z.string().nullable(),
  thread_root_message_id: z.string().nullable(),
  forwarded_from_message_id: z.string().nullable(),
  attachment_meta: z.unknown().nullable(),
  agora_event_id: z.string().nullable(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
