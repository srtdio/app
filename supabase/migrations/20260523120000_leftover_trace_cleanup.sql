-- Leftover-trace cleanup. Schema already applied to movnexawfhsyuluspxoc. Do NOT execute.
-- Drops dead CHECK values (plan_cell, plan_period, share_token, plan channel regex),
-- drops dead workspace_onboarding columns (linkedin_connected_at, first_schedule_at),
-- adds agora to webhook_events.source, drops stale plan_cells_enforce_row_version function.

-- comments.entity_type: drop plan_cell
ALTER TABLE public.comments DROP CONSTRAINT comments_entity_type_check;
ALTER TABLE public.comments
 ADD CONSTRAINT comments_entity_type_check
 CHECK (entity_type = ANY (ARRAY['post'::text, 'brief'::text]));

-- inbox_entries.entity_type: drop plan_cell + plan_period, keep chat_channel + workspace
ALTER TABLE public.inbox_entries DROP CONSTRAINT inbox_entries_entity_type_check;
ALTER TABLE public.inbox_entries
 ADD CONSTRAINT inbox_entries_entity_type_check
 CHECK (entity_type IS NULL OR entity_type = ANY (ARRAY['post'::text, 'brief'::text, 'chat_channel'::text, 'workspace'::text]));

-- chat_channels.channel_type: drop plan_period
ALTER TABLE public.chat_channels DROP CONSTRAINT chat_channels_channel_type_check;
ALTER TABLE public.chat_channels
 ADD CONSTRAINT chat_channels_channel_type_check
 CHECK (channel_type = ANY (ARRAY['dm'::text, 'group'::text]));

-- chat_channels.channel_id regex: drop plan
ALTER TABLE public.chat_channels DROP CONSTRAINT chat_channels_channel_id_check;
ALTER TABLE public.chat_channels
 ADD CONSTRAINT chat_channels_channel_id_check
 CHECK (channel_id ~ '^(dm|group)__[a-f0-9-]{36}__.+$');

-- intent_ledger.target_type: drop share_token
ALTER TABLE public.intent_ledger DROP CONSTRAINT intent_ledger_target_type_check;
ALTER TABLE public.intent_ledger
 ADD CONSTRAINT intent_ledger_target_type_check
 CHECK (target_type IS NULL OR target_type = ANY (ARRAY['workspace'::text, 'user'::text, 'flag'::text, 'deploy'::text]));

-- workspace_onboarding: drop dead columns
ALTER TABLE public.workspace_onboarding
 DROP COLUMN linkedin_connected_at,
 DROP COLUMN first_schedule_at;

-- webhook_events.source: add agora
ALTER TABLE public.webhook_events DROP CONSTRAINT webhook_events_source_check;
ALTER TABLE public.webhook_events
 ADD CONSTRAINT webhook_events_source_check
 CHECK (source = ANY (ARRAY['stripe'::text, 'resend'::text, 'linkedin'::text, 'agora'::text]));

-- drop stale function referencing dead plan_cells table
DROP FUNCTION IF EXISTS public.plan_cells_enforce_row_version();
