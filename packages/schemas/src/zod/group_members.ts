import { z } from 'zod';

export const GroupMemberSchema = z.object({
  group_id: z.string().uuid(),
  user_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  joined_at: z.string(),
});

export type GroupMember = z.infer<typeof GroupMemberSchema>;
