import { z } from 'zod';

export const AssetVersionSchema = z.object({
  id: z.string().uuid(),
  asset_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  version_number: z.number().int(),
  r2_key: z.string(),
  mime_type: z.string(),
  sha256: z.string(),
  size_bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  uploaded_by: z.string().uuid(),
  uploaded_at: z.string(),
});

export type AssetVersion = z.infer<typeof AssetVersionSchema>;
