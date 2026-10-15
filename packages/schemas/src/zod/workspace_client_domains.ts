import { z } from 'zod';

export const WorkspaceClientDomainSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
  approved_by: z.string().uuid(),
  created_at: z.string(),
  removed_at: z.string().nullable(),
  removed_by: z.string().uuid().nullable(),
});

export type WorkspaceClientDomain = z.infer<typeof WorkspaceClientDomainSchema>;
