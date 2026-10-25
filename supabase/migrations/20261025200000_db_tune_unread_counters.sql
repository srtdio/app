-- Already applied live to movnexawfhsyuluspxoc on 2026-10-25. Replays on the ephemeral RLS DB.
-- DB tune + chat unread counters.
-- 1. anon/authenticated lose TRUNCATE, TRIGGER, REFERENCES, MAINTAIN on every
--    public table, now and by default for new tables.
-- 2. Covering indexes for hot RLS / FK lookups.
-- 3. Every public policy calls auth.uid()/auth.role()/auth.jwt() as an initplan
--    ((select auth.uid())). Idempotent: matches nothing once applied.
-- 4. chat_unread_counters: one row per (channel, user), kept by a trigger on
--    chat_messages (insert, soft delete, undelete), reset by read cursor and
--    clear. chat_unread_counts reads it instead of counting messages.
-- 5. One merged permissive SELECT policy per table on assets, briefs,
--    delivery_attempts, feature_flags, workspace_members.
-- 6. Drops dead functions (chat tasks, checkpoints, legacy helpers).
-- 7. Drops unused indexes.
-- Function bodies are pg_get_functiondef output from live, verbatim.

-- (1) Table privileges.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;
-- MAINTAIN exists from PG17; EXECUTE keeps an older parser from rejecting it.
DO $$
BEGIN
  EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
EXCEPTION WHEN syntax_error OR undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
EXCEPTION WHEN syntax_error OR undefined_object THEN NULL;
END $$;

-- (2) Indexes.
CREATE INDEX IF NOT EXISTS workspace_members_user_active_idx
  ON public.workspace_members USING btree (user_id) WHERE (active = true);
CREATE INDEX IF NOT EXISTS post_annotations_post_idx
  ON public.post_annotations USING btree (post_id);
CREATE INDEX IF NOT EXISTS chat_channel_clears_user_idx
  ON public.chat_channel_clears USING btree (user_id);
CREATE INDEX IF NOT EXISTS workspaces_owner_user_idx
  ON public.workspaces USING btree (owner_user_id);
-- inbox_entries is partitioned; the parent index cascades to partitions.
CREATE INDEX IF NOT EXISTS inbox_entries_ws_user_read_idx
  ON public.inbox_entries USING btree (workspace_id, user_id, read_at, created_at DESC);

-- (3) Wrap bare auth.uid()/auth.role()/auth.jwt() in policies as (select ...).
-- pg_policies renders an already wrapped call as "( SELECT auth.uid() AS uid)",
-- so a call preceded by "SELECT " is skipped.
DO $$
DECLARE
  p record;
  v_pat constant text := '(?<!SELECT )auth\.(uid|role|jwt)\(\)';
  v_qual text;
  v_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (coalesce(qual, '') ~ v_pat OR coalesce(with_check, '') ~ v_pat)
  LOOP
    v_qual := regexp_replace(p.qual, v_pat, '(select auth.\1())', 'g');
    v_check := regexp_replace(p.with_check, v_pat, '(select auth.\1())', 'g');
    IF p.qual IS NOT NULL AND v_qual IS DISTINCT FROM p.qual THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)',
                     p.policyname, p.schemaname, p.tablename, v_qual);
    END IF;
    IF p.with_check IS NOT NULL AND v_check IS DISTINCT FROM p.with_check THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
                     p.policyname, p.schemaname, p.tablename, v_check);
    END IF;
  END LOOP;
END $$;

-- (4) Chat unread counters.
CREATE TABLE IF NOT EXISTS public.chat_unread_counters (
  workspace_id uuid NOT NULL,
  channel_id text NOT NULL,
  user_id uuid NOT NULL,
  unread integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_unread_counters_pkey PRIMARY KEY (channel_id, user_id),
  CONSTRAINT chat_unread_counters_unread_check CHECK ((unread >= 0)),
  CONSTRAINT chat_unread_counters_channel_id_fkey FOREIGN KEY (channel_id)
    REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  CONSTRAINT chat_unread_counters_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT chat_unread_counters_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_unread_counters_user_workspace_idx
  ON public.chat_unread_counters USING btree (user_id, workspace_id);

ALTER TABLE public.chat_unread_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_unread_counters_select_own ON public.chat_unread_counters;
CREATE POLICY chat_unread_counters_select_own ON public.chat_unread_counters
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = ( SELECT auth.uid() AS uid)));

-- Table privileges mirror live EXACTLY: authenticated SELECT only; anon none;
-- service_role keeps only the REFERENCES/TRIGGER/TRUNCATE/MAINTAIN defaults
-- (writes go through SECURITY DEFINER procs and the trigger).
REVOKE ALL ON TABLE public.chat_unread_counters FROM PUBLIC, anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_unread_counters FROM service_role;
GRANT SELECT ON TABLE public.chat_unread_counters TO authenticated;
-- srtdio_readonly exists only on the hosted project; guard the grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srtdio_readonly') THEN
    GRANT SELECT ON public.chat_unread_counters TO srtdio_readonly;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.chat_unread_bump(p_message_id text, p_channel_id text, p_workspace_id uuid, p_sender_id uuid, p_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_at timestamptz := p_created_at;
begin
  if v_at is null then
    select m.created_at into v_at from public.chat_messages m where m.id = p_message_id and m.channel_id = p_channel_id limit 1;
  end if;
  if v_at is null or v_at <= now() - interval '90 days' then return; end if;
  insert into public.chat_unread_counters (workspace_id, channel_id, user_id, unread, updated_at)
  select p_workspace_id, p_channel_id, wm.user_id, 1, now()
  from public.workspace_members wm
  left join public.chat_read_cursors rc on rc.channel_id = p_channel_id and rc.user_id = wm.user_id
  left join public.chat_channel_clears cc on cc.channel_id = p_channel_id and cc.user_id = wm.user_id
  where wm.workspace_id = p_workspace_id and wm.active = true
    and wm.user_id is distinct from p_sender_id
    and (rc.last_read_at is null or v_at > rc.last_read_at)
    and v_at > coalesce(cc.cleared_at, '-infinity'::timestamptz)
    and public.chat_channel_member(p_channel_id, wm.user_id)
  on conflict (channel_id, user_id) do update
    set unread = public.chat_unread_counters.unread + 1, updated_at = now();
end $function$
;

CREATE OR REPLACE FUNCTION public.chat_unread_decrement(p_message_id text, p_channel_id text, p_workspace_id uuid, p_sender_id uuid, p_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_at timestamptz := p_created_at;
begin
  if v_at is null then
    select m.created_at into v_at from public.chat_messages m where m.id = p_message_id and m.channel_id = p_channel_id limit 1;
  end if;
  if v_at is null then return; end if;
  update public.chat_unread_counters u
     set unread = greatest(u.unread - 1, 0), updated_at = now()
   where u.channel_id = p_channel_id
     and u.unread > 0
     and u.user_id is distinct from p_sender_id
     and not exists (select 1 from public.chat_read_cursors rc where rc.channel_id = p_channel_id and rc.user_id = u.user_id and v_at <= rc.last_read_at)
     and v_at > public.chat_cleared_at(p_channel_id, u.user_id);
end $function$
;

CREATE OR REPLACE FUNCTION public._chat_unread_on_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      perform public.chat_unread_bump(new.id, new.channel_id, new.workspace_id, new.sender_user_id, new.created_at);
    end if;
  elsif tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      perform public.chat_unread_decrement(old.id, old.channel_id, old.workspace_id, old.sender_user_id, old.created_at);
    elsif old.deleted_at is not null and new.deleted_at is null then
      perform public.chat_unread_bump(new.id, new.channel_id, new.workspace_id, new.sender_user_id, new.created_at);
    end if;
  end if;
  return null;
end $function$
;

-- Internal only: live proacl is {postgres=X/postgres}.
REVOKE ALL ON FUNCTION public.chat_unread_bump(text, text, uuid, uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_unread_decrement(text, text, uuid, uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._chat_unread_on_message() FROM PUBLIC, anon, authenticated, service_role;

-- Existing procs, now counter-aware. CREATE OR REPLACE keeps their grants.
CREATE OR REPLACE FUNCTION public.chat_read_cursor_set(p_channel_id text, p_message_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid; v_msg_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id, created_at INTO v_workspace_id, v_msg_at FROM public.chat_messages WHERE id = p_message_id AND channel_id = p_channel_id LIMIT 1;
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'message not found'; END IF;
  INSERT INTO public.chat_read_cursors (channel_id, user_id, workspace_id, last_read_message_id, last_read_at, read_at)
  VALUES (p_channel_id, v_actor, v_workspace_id, p_message_id, v_msg_at, now())
  ON CONFLICT (channel_id, user_id) DO UPDATE
    SET last_read_message_id = EXCLUDED.last_read_message_id, last_read_at = EXCLUDED.last_read_at, read_at = now(), updated_at = now()
    WHERE EXCLUDED.last_read_at > public.chat_read_cursors.last_read_at;
  UPDATE public.chat_unread_counters u
     SET unread = (SELECT count(*)::int FROM public.chat_messages m
                    WHERE m.channel_id = p_channel_id AND m.deleted_at IS NULL
                      AND m.created_at > now() - interval '90 days'
                      AND m.sender_user_id IS DISTINCT FROM v_actor
                      AND m.created_at > (SELECT rc.last_read_at FROM public.chat_read_cursors rc WHERE rc.channel_id = p_channel_id AND rc.user_id = v_actor)
                      AND m.created_at > public.chat_cleared_at(p_channel_id, v_actor)),
         updated_at = now()
   WHERE u.channel_id = p_channel_id AND u.user_id = v_actor;
END; $function$
;

CREATE OR REPLACE FUNCTION public.chat_channel_clear(p_channel_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_channels WHERE channel_id = p_channel_id;
  INSERT INTO public.chat_channel_clears (channel_id, user_id, workspace_id, cleared_at)
  VALUES (p_channel_id, v_actor, v_workspace_id, now())
  ON CONFLICT (channel_id, user_id) DO UPDATE SET cleared_at = now();
  UPDATE public.chat_unread_counters SET unread = 0, updated_at = now()
   WHERE channel_id = p_channel_id AND user_id = v_actor;
END; $function$
;

CREATE OR REPLACE FUNCTION public.chat_unread_counts(p_workspace_id uuid)
 RETURNS TABLE(channel_id text, unread bigint, last_message_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT c.channel_id,
         coalesce(u.unread, 0)::bigint AS unread,
         lm.last_message_at
  FROM public.chat_channels c
  CROSS JOIN LATERAL (
    SELECT max(m.created_at) AS last_message_at
    FROM public.chat_messages m
    WHERE m.channel_id = c.channel_id
      AND m.workspace_id = p_workspace_id
      AND m.deleted_at IS NULL
      AND m.created_at > now() - interval '90 days'
  ) lm
  LEFT JOIN public.chat_unread_counters u ON u.channel_id = c.channel_id AND u.user_id = (select auth.uid())
  WHERE c.workspace_id = p_workspace_id
    AND lm.last_message_at IS NOT NULL;
$function$
;

CREATE OR REPLACE FUNCTION public.chat_reminders_fire(p_limit integer DEFAULT 500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_count integer;
begin
  IF NOT EXISTS (SELECT 1 FROM public.chat_message_reminders WHERE fired_at IS NULL AND cancelled_at IS NULL AND remind_at <= now()) THEN RETURN 0; END IF;
  with due as (
    select r.id from public.chat_message_reminders r
    where r.fired_at is null and r.cancelled_at is null and r.remind_at <= now()
    order by r.remind_at limit least(greatest(coalesce(p_limit, 500), 1), 2000) for update skip locked),
  marked as (
    update public.chat_message_reminders r set fired_at = now() from due where r.id = due.id
    returning r.id, r.user_id, r.message_id, r.channel_id, r.workspace_id),
  ins as (
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select m.user_id, m.workspace_id, 'reminder', 'chat_channel', m.channel_id,
      case when c.channel_type = 'group' then 'groups' else 'people' end, m.channel_id, 'urgent',
      jsonb_build_object('message_id', m.message_id, 'reminder_id', m.id), null
    from marked m join public.chat_channels c on c.channel_id = m.channel_id
    where public.chat_channel_member(m.channel_id, m.user_id)
      and exists (select 1 from public.chat_messages x where x.id = m.message_id and x.channel_id = m.channel_id and x.deleted_at is null)
    returning 1)
  select count(*) into v_count from ins;
  return v_count;
end $function$
;

DROP TRIGGER IF EXISTS chat_messages_unread_counters ON public.chat_messages;
CREATE TRIGGER chat_messages_unread_counters
  AFTER INSERT OR UPDATE OF deleted_at ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public._chat_unread_on_message();

-- Backfill: same rules as chat_unread_bump / chat_read_cursor_set. Last 90 days,
-- not deleted, not the user's own, after the read cursor, after the clear,
-- active member of the workspace and of the chat.
INSERT INTO public.chat_unread_counters (workspace_id, channel_id, user_id, unread, updated_at)
SELECT m.workspace_id, m.channel_id, wm.user_id, count(*)::int, now()
  FROM public.chat_messages m
  JOIN public.workspace_members wm
    ON wm.workspace_id = m.workspace_id AND wm.active = true
  LEFT JOIN public.chat_read_cursors rc
    ON rc.channel_id = m.channel_id AND rc.user_id = wm.user_id
  LEFT JOIN public.chat_channel_clears cc
    ON cc.channel_id = m.channel_id AND cc.user_id = wm.user_id
 WHERE m.deleted_at IS NULL
   AND m.created_at > now() - interval '90 days'
   AND m.sender_user_id IS DISTINCT FROM wm.user_id
   AND (rc.last_read_at IS NULL OR m.created_at > rc.last_read_at)
   AND m.created_at > coalesce(cc.cleared_at, '-infinity'::timestamptz)
   AND public.chat_channel_member(m.channel_id, wm.user_id)
 GROUP BY m.workspace_id, m.channel_id, wm.user_id
HAVING count(*) > 0
ON CONFLICT (channel_id, user_id) DO UPDATE
  SET unread = EXCLUDED.unread, updated_at = now();

-- (5) One merged permissive SELECT policy per table.
-- assets: replaces assets_select_member + assets_select_deleted_member.
DROP POLICY IF EXISTS assets_select_member ON public.assets;
DROP POLICY IF EXISTS assets_select_deleted_member ON public.assets;
DROP POLICY IF EXISTS assets_select ON public.assets;
CREATE POLICY assets_select ON public.assets AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((deleted_at IS NULL) AND (origin = 'library'::text) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = assets.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true))))) OR ((deleted_at IS NOT NULL) AND (origin = 'library'::text) AND (purge_requested_at IS NULL) AND is_active_workspace_member(workspace_id))));

-- briefs: replaces briefs_select_agency + briefs_select_client
-- (briefs_select_client_own was already dropped by 20260727130118).
DROP POLICY IF EXISTS briefs_select_agency ON public.briefs;
DROP POLICY IF EXISTS briefs_select_client ON public.briefs;
DROP POLICY IF EXISTS briefs_select_client_own ON public.briefs;
DROP POLICY IF EXISTS briefs_select ON public.briefs;
CREATE POLICY briefs_select ON public.briefs AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = briefs.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'agency'::text])))))) OR ((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = briefs.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true) AND (wm.role = 'client'::text)))))));

-- delivery_attempts: replaces delivery_attempts_select_member + delivery_attempts_select_operator.
DROP POLICY IF EXISTS delivery_attempts_select_member ON public.delivery_attempts;
DROP POLICY IF EXISTS delivery_attempts_select_operator ON public.delivery_attempts;
DROP POLICY IF EXISTS delivery_attempts_select ON public.delivery_attempts;
CREATE POLICY delivery_attempts_select ON public.delivery_attempts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = delivery_attempts.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true))))) OR (EXISTS ( SELECT 1
   FROM platform_operators po
  WHERE ((po.user_id = ( SELECT auth.uid() AS uid)) AND (po.revoked_at IS NULL))))));

-- feature_flags: replaces feature_flags_select_member + feature_flags_select_operator.
DROP POLICY IF EXISTS feature_flags_select_member ON public.feature_flags;
DROP POLICY IF EXISTS feature_flags_select_operator ON public.feature_flags;
DROP POLICY IF EXISTS feature_flags_select ON public.feature_flags;
CREATE POLICY feature_flags_select ON public.feature_flags AS PERMISSIVE FOR SELECT TO authenticated
  USING (((workspace_id IS NULL) OR (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = feature_flags.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true)))) OR (EXISTS ( SELECT 1
   FROM platform_operators po
  WHERE ((po.user_id = ( SELECT auth.uid() AS uid)) AND (po.revoked_at IS NULL))))));

-- workspace_members: replaces workspace_members_select_member (the own-row
-- policy it also absorbed was never recorded in a migration).
DROP POLICY IF EXISTS workspace_members_select_member ON public.workspace_members;
DROP POLICY IF EXISTS workspace_members_select ON public.workspace_members;
CREATE POLICY workspace_members_select ON public.workspace_members AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active_workspace_member(workspace_id) OR (user_id = ( SELECT auth.uid() AS uid))));

-- (6) Dead functions.
-- chat_tasks_fire_due was unscheduled by 20261019063000; guard again in case
-- the job exists. CI containers have no pg_cron.
DO $$
BEGIN
  -- Nested and dynamic so cron.job is never parsed when pg_cron is absent.
  IF to_regclass('cron.job') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
      EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''chat-tasks-fire-due''';
    END IF;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.chat_task_create(text, text, text, text, smallint, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.chat_task_create_many(text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.chat_task_delete(uuid, uuid);
DROP FUNCTION IF EXISTS public.chat_task_save(uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS public.chat_task_set(uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public.chat_tasks_fire_due(integer);
-- Takes the public.chat_tasks rowtype; skip if the table is gone.
DO $$
BEGIN
  DROP FUNCTION IF EXISTS public.chat_task_event_write(public.chat_tasks, text, text, text, uuid, text);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
DROP FUNCTION IF EXISTS public.checkpoint_ask(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.checkpoint_send_back(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.has_capability(text);
DROP FUNCTION IF EXISTS public.workspace_id();
DROP FUNCTION IF EXISTS public.inbox_mark_read_events(uuid, text[], uuid);
DROP FUNCTION IF EXISTS public.domain_brand_word(text);
DROP FUNCTION IF EXISTS public.plan_item_move(uuid, date, uuid[], uuid);

-- (7) Unused indexes.
DROP INDEX IF EXISTS public.assets_filename_fts_idx;
DROP INDEX IF EXISTS public.assets_tags_idx;
DROP INDEX IF EXISTS public.briefs_target_date_idx;
DROP INDEX IF EXISTS public.cockpit_access_log_session_idx;
DROP INDEX IF EXISTS public.cockpit_access_log_trace_idx;
DROP INDEX IF EXISTS public.comments_open_checkpoints_idx;
DROP INDEX IF EXISTS public.feature_flags_category_idx;
DROP INDEX IF EXISTS public.feature_flags_global_idx;
DROP INDEX IF EXISTS public.groups_workspace_idx;
DROP INDEX IF EXISTS public.intent_ledger_pending_expiry_idx;
DROP INDEX IF EXISTS public.intent_ledger_target_idx;
DROP INDEX IF EXISTS public.intent_ledger_trace_idx;
DROP INDEX IF EXISTS public.pending_flows_external_idx;
DROP INDEX IF EXISTS public.pending_flows_open_expiry_idx;
DROP INDEX IF EXISTS public.session_devices_user_id_idx;
DROP INDEX IF EXISTS public.users_deleted_at_idx;
DROP INDEX IF EXISTS public.webhook_events_unverified_idx;
DROP INDEX IF EXISTS public.webhook_processing_attempts_pending_idx;
DROP INDEX IF EXISTS public.webhook_processing_attempts_trace_idx;
DROP INDEX IF EXISTS public.asset_versions_asset_idx;
DROP INDEX IF EXISTS public.post_versions_post_idx;
DROP INDEX IF EXISTS public.comments_checkpoint_accept_idx;
DROP INDEX IF EXISTS public.comments_ledger_live_idx;
