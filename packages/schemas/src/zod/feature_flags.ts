import { z } from 'zod';

export const FeatureFlagSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid().nullable(),
  flag_name: z.string(),
  category: z.enum(['killswitch', 'rollout', 'experiment', 'tier_gated']),
  enabled: z.boolean(),
  rollout_percentage: z.number().int(),
  tier_min: z.string().nullable(),
  reason: z.string().nullable(),
  updated_by: z.string().uuid().nullable(),
  updated_at: z.string(),
});

export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
