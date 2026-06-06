import { z } from 'zod';

export const AssetSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  filename: z.string(),
  current_version_id: z.string().uuid().nullable(),
  folder_path: z.string(),
  tags: z.array(z.string()),
  uploaded_by: z.string().uuid(),
  uploaded_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Asset = z.infer<typeof AssetSchema>;
