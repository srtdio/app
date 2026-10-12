-- Applied out of band 12 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- Plan notify plumbing (Draft/Open wave, change 1): inbox_entries admits the
-- plan alerts and a 'plan' entity; _plan_notify fans a plan alert out to the
-- plan's audience. Internal helper: no EXECUTE for anyone.
-- This file carries the FULL _plan_notify body. Live currently runs a SILENT
-- body (20261012161000_plan_one_date_per_post.sql) until part 2b restores this.
--
-- DESTRUCTIVE: drops and re-adds inbox_entries_event_type_check and
-- inbox_entries_entity_type_check (widens both, no data loss).
-- Rollback: delete inbox_entries rows with event_type in ('plan_opened',
-- 'plan_deleted','plan_date_changed') or entity_type = 'plan', re-add both
-- CHECKs without those values, drop function public._plan_notify(uuid, text, jsonb)
-- after the callers in the next two migrations are restored.

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK ((event_type = ANY (ARRAY['comment'::text, 'mention'::text, 'stage_change'::text, 'comment_resolved'::text, 'brief_created'::text, 'brief_closed'::text, 'asset_uploaded'::text, 'asset_version_added'::text, 'invite'::text, 'trial_warning'::text, 'billing_failure'::text, 'system'::text, 'checkpoints_added'::text, 'post_ready'::text, 'checkpoint_reopened'::text, 'checkpoint_asked'::text, 'scheduled_sent'::text, 'scheduled_failed'::text, 'reminder'::text, 'post_deleted'::text, 'assets_deleted'::text, 'plan_comment'::text, 'plan_review'::text, 'plan_opened'::text, 'plan_deleted'::text, 'plan_date_changed'::text])));

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_entity_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_entity_type_check
  CHECK (((entity_type IS NULL) OR (entity_type = ANY (ARRAY['post'::text, 'brief'::text, 'chat_channel'::text, 'workspace'::text, 'plan_item'::text, 'plan'::text]))));

CREATE OR REPLACE FUNCTION public._plan_notify(p_plan_id uuid, p_event_type text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text;
begin
  select workspace_id, audience into v_ws, v_aud from public.plans where id = p_plan_id;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, p_event_type, 'plan', p_plan_id::text, 'posts', p_plan_id::text, 'active',
         coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('plan_id', p_plan_id), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id is distinct from auth.uid()
     and (wm.role = any (array['owner','admin','agency']) or (v_aud = 'client' and wm.role = 'client'));
end $function$
;

REVOKE ALL ON FUNCTION public._plan_notify(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
