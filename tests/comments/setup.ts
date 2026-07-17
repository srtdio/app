// Vitest globalSetup for the comments suite. Reuses the RLS suite's local
// Supabase bring-up verbatim (the same ephemeral container, the same applied
// migrations, the same temp env handoff file). Nothing here touches the live
// database.
//
// Historical note: this file used to patch inbox_entries_event_type_check on the
// local stack to admit 'checkpoints_added' / 'post_ready', because the feedback-
// ledger migration emitted those values but no migration had widened the
// constraint. That widening now ships as a real migration
// (20260717120000_widen_inbox_event_type_check.sql), so the ephemeral stack gets
// it from supabase/migrations/ like every other change. Removing the local-only
// patch is deliberate: it lets tests/comments/event-type-constraint.test.ts read
// the constraint the MIGRATION produces and assert it matches the canonical app
// list. If the patch re-appeared it would mask a migration that forgot a value.

import { setup as rlsSetup, teardown } from '../rls/setup';

export async function setup(): Promise<void> {
  await rlsSetup();
}

export { teardown };
