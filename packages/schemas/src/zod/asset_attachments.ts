import { z } from 'zod';

export const AssetAttachmentSchema = z.object({
  id: z.string().uuid(),
  asset_id: z.string().uuid(),
  asset_version_id: z.string().uuid(),
  entity_type: z.string(),
  entity_id: z.string(),
  workspace_id: z.string().uuid(),
  position: z.number().int(),
  attached_by: z.string().uuid(),
  attached_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type AssetAttachment = z.infer<typeof AssetAttachmentSchema>;
