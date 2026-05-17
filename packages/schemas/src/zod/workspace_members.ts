import { z } from 'zod';

export const WorkspaceMemberSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'agency', 'client']),
  active: z.boolean(),
  invited_by: z.string().uuid().nullable(),
  invited_at: z.string(),
  accepted_at: z.string().nullable(),
  removed_at: z.string().nullable(),
  rejoined_at: z.string().nullable(),
});

export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
