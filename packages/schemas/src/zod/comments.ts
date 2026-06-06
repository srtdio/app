import { z } from 'zod';

export const CommentSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  entity_type: z.enum(['post', 'brief']),
  entity_id: z.string().uuid(),
  parent_comment_id: z.string().uuid().nullable(),
  author_user_id: z.string().uuid(),
  body: z.string(),
  mentions: z.unknown().nullable(),
  attachment_asset_ids: z.array(z.string().uuid()).nullable(),
  is_decision: z.boolean(),
  edited_at: z.string().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Comment = z.infer<typeof CommentSchema>;
