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
  asset_bucket: z.string().nullable(),
  platform: z.enum([
    'instagram',
    'x',
    'threads',
    'linkedin',
    'facebook',
    'tiktok',
    'youtube_shorts',
  ]),
  client_domain: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)
    .nullable(),
  logo_url: z
    .string()
    .regex(/^https:\/\//)
    .nullable(),
  row_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
