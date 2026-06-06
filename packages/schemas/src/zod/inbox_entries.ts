import { z } from 'zod';

export const InboxEntrySchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  event_type: z.enum([
    'comment',
    'mention',
    'stage_change',
    'decision_marked',
    'brief_created',
    'brief_closed',
    'asset_uploaded',
    'asset_version_added',
    'invite',
    'trial_warning',
    'billing_failure',
    'system',
  ]),
  entity_type: z.enum(['post', 'brief', 'chat_channel', 'workspace']).nullable(),
  entity_id: z.string().nullable(),
  scope: z.enum(['everything', 'posts', 'briefs', 'people', 'groups', 'clients']),
  scope_key: z.string().nullable(),
  tier: z.enum(['urgent', 'active', 'ambient']),
  payload: z.unknown(),
  read_at: z.string().nullable(),
  snoozed_until: z.string().nullable(),
  email_sent_at: z.string().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type InboxEntry = z.infer<typeof InboxEntrySchema>;
