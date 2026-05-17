import { z } from 'zod';

export const WorkspaceSettingsSchema = z.object({
  workspace_id: z.string().uuid(),
  payload: z.unknown(),
  updated_at: z.string(),
  updated_by: z.string().uuid().nullable(),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
