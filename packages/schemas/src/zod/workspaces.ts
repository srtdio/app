import { z } from 'zod';

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  owner_user_id: z.string().uuid(),
  plan_tier: z.enum(['solo', 'studio', 'agency', 'enterprise']),
  timezone: z.string(),
  week_start_day: z.number().int().min(0).max(6),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  subscription_state: z.enum([
    'trial',
    'active',
    'read_only',
    'grace',
    'soft_pause',
    'full_pause',
    'soft_delete',
  ]),
  subscription_state_expires_at: z.string().nullable(),
  trial_ends_at: z.string().nullable(),
  activated_at: z.string().nullable(),
  digest_default_time: z.string(),
  target_distributions: z.unknown(),
  row_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
