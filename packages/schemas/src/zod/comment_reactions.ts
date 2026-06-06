import { z } from 'zod';

export const CommentReactionSchema = z.object({
  comment_id: z.string().uuid(),
  user_id: z.string().uuid(),
  emoji: z.string(),
  workspace_id: z.string().uuid(),
  created_at: z.string(),
});

export type CommentReaction = z.infer<typeof CommentReactionSchema>;
