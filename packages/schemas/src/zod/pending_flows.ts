import { z } from 'zod';

export const PendingFlowSchema = z.object({
  id: z.string().uuid(),
  operator_user_id: z.string().uuid(),
  flow_type: z.enum(['billing_override', 'sentry_inspect', 'cf_purge', 'gh_diff']),
  external_system: z.enum(['stripe', 'sentry', 'cloudflare', 'github', 'resend']),
  external_ref: z.string().nullable(),
  payload: z.unknown(),
  status: z.enum(['open', 'resolved', 'discarded', 'expired']),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  expires_at: z.string(),
});

export type PendingFlow = z.infer<typeof PendingFlowSchema>;
