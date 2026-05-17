import { z } from 'zod';

export const WorkspaceRolePermissionSchema = z.object({
  workspace_id: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'agency', 'client']),
  capability: z.string(),
  allowed: z.boolean(),
  updated_at: z.string(),
});

export type WorkspaceRolePermission = z.infer<typeof WorkspaceRolePermissionSchema>;
