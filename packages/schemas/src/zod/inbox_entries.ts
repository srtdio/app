import { z } from 'zod';

/**
 * Canonical inbox_entries.event_type value set: the SINGLE SOURCE OF TRUTH the
 * app shares with the DB CHECK constraint inbox_entries_event_type_check.
 *
 * Invariant (asserted by tests):
 *  - this list is IDENTICAL to the live constraint's value set
 *    (tests/comments/event-type-constraint.test.ts reads pg_constraint and
 *    compares), and
 *  - every emitter subset (the inbox-writer worker's WORKER_INBOX_EVENT_TYPES,
 *    the catch-up email's CATCHUP_EVENT_TYPES) is a SUBSET of this list
 *    (src/lib/inbox/event-types.test.ts).
 *
 * That pair is what stops the drift bug class: an emitter can never ship a value
 * the DB rejects (as 'checkpoints_added' / 'post_ready' once did) without a test
 * going red. When the DB constraint changes, change THIS list in the same PR.
 */
export const INBOX_EVENT_TYPES = [
  'comment',
  'mention',
  'stage_change',
  'comment_resolved',
  'brief_created',
  'brief_closed',
  'asset_uploaded',
  'asset_version_added',
  'invite',
  'trial_warning',
  'billing_failure',
  'system',
  'checkpoints_added',
  'post_ready',
] as const;

/** One inbox_entries.event_type value, derived from the canonical list. */
export type InboxEventTypeValue = (typeof INBOX_EVENT_TYPES)[number];

export const InboxEntrySchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  event_type: z.enum(INBOX_EVENT_TYPES),
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
