// Vitest globalSetup for the comments suite. Reuses the RLS suite's local
// Supabase bring-up verbatim (the same ephemeral container, the same applied
// migrations, the same temp env handoff file), then applies one LOCAL-ONLY
// patch, below. Nothing here touches the live database.
//
// Local-only patch: the applied feedback-ledger change (migration
// 20260716120000_feedback_ledger.sql, history only) has comment_batch_create
// and post_ready_notify insert inbox_entries with event_type
// 'checkpoints_added' / 'post_ready', but inbox_entries_event_type_check was
// never widened to allow those values - neither in the migration history nor,
// verified 2026-07-16 via pg_constraint, on the live database. Until the
// Shubham-approved constraint fix lands on live (see the Feedback ledger
// section of docs/schema.md), the local test stack widens the constraint here
// so the suites can validate the procs' intended behavior.

import { execFileSync } from 'node:child_process';
import { loadRlsEnv } from '../../packages/test-utils/rls';
import { setup as rlsSetup, teardown } from '../rls/setup';

const WIDEN_INBOX_EVENT_TYPES_SQL = `
ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK (event_type = ANY (ARRAY['comment','mention','stage_change','comment_resolved',
    'brief_created','brief_closed','asset_uploaded','asset_version_added',
    'invite','trial_warning','billing_failure','system',
    'checkpoints_added','post_ready']));
`;

/**
 * Widen inbox_entries_event_type_check on the LOCAL ephemeral stack to admit
 * the feedback-ledger event types. Idempotent; also called by the DB-backed
 * post_ready_notify suite (tests/posts/ready-notify.test.ts), which shares the
 * same local stack.
 */
export function widenLocalInboxEventTypes(dbUrl: string): void {
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', WIDEN_INBOX_EVENT_TYPES_SQL], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function setup(): Promise<void> {
  await rlsSetup();
  widenLocalInboxEventTypes(loadRlsEnv().dbUrl);
}

export { teardown };
