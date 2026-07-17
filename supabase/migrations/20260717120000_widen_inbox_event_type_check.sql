-- Widen inbox_entries_event_type_check to admit the feedback-ledger event types
-- 'checkpoints_added' (written by public.comment_batch_create) and 'post_ready'
-- (written by public.post_ready_notify).
--
-- Incident: both procs fan out to inbox_entries with an event_type the constraint
-- did not allow, so the insert raised inbox_entries_event_type_check and, because
-- each proc is one transaction, rolled back every comment inserted above it. The
-- points ledger never wrote a row. comment_batch_create fails on every "Send N
-- points"; post_ready_notify fails once all checkpoints are resolved.
--
-- DROP/ADD on the partitioned parent public.inbox_entries propagates to all
-- partitions (2026_05 .. 2027_12). Verified in a rolled-back transaction on live
-- 2026-07-17 (2362 rows, instant).
--
-- PENDING: apply to production via the Supabase MCP after approval. This file is
-- the source of the statements and is applied to the ephemeral test stacks by the
-- suite bring-up; it is NOT marked as already applied to live.

ALTER TABLE public.inbox_entries
  DROP CONSTRAINT inbox_entries_event_type_check;

ALTER TABLE public.inbox_entries
  ADD CONSTRAINT inbox_entries_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'comment','mention','stage_change','comment_resolved',
    'brief_created','brief_closed','asset_uploaded','asset_version_added',
    'invite','trial_warning','billing_failure','system',
    'checkpoints_added','post_ready'
  ]));
