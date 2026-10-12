-- Applied out of band 12 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- Plan updated alerts (Draft/Open wave, change 4): inbox_entries admits
-- 'plan_updated'; plan_items_change_notify announces slot_added (insert),
-- slot_removed (soft delete) and concept_changed (a live concept's title or
-- description); plans_rename_notify announces renamed. All via _plan_notify,
-- which is SILENT on live until part 2b. _posts_plan_day_sync sets
-- app.plan_day_sync on/off around its own soft delete so a post leaving the
-- plan by date is announced once (plan_date_changed only). Function bodies are
-- verbatim pg_get_functiondef from live; the trigger functions have no EXECUTE
-- for anyone.
--
-- DESTRUCTIVE: drops and re-adds inbox_entries_event_type_check (widens, no
-- data loss).
-- Rollback: drop triggers plan_items_change_notify and plans_rename_notify and
-- functions public._plan_items_change_notify() and public._plans_rename_notify();
-- restore _posts_plan_day_sync from 20261012161000_plan_one_date_per_post.sql;
-- delete inbox_entries rows with event_type 'plan_updated' and re-add the
-- 26-value CHECK from 20261012160000_plan_notify_plumbing.sql.

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK ((event_type = ANY (ARRAY['comment'::text, 'mention'::text, 'stage_change'::text, 'comment_resolved'::text, 'brief_created'::text, 'brief_closed'::text, 'asset_uploaded'::text, 'asset_version_added'::text, 'invite'::text, 'trial_warning'::text, 'billing_failure'::text, 'system'::text, 'checkpoints_added'::text, 'post_ready'::text, 'checkpoint_reopened'::text, 'checkpoint_asked'::text, 'scheduled_sent'::text, 'scheduled_failed'::text, 'reminder'::text, 'post_deleted'::text, 'assets_deleted'::text, 'plan_comment'::text, 'plan_review'::text, 'plan_opened'::text, 'plan_deleted'::text, 'plan_date_changed'::text, 'plan_updated'::text])));

CREATE OR REPLACE FUNCTION public._plan_items_change_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    perform public._plan_notify(new.plan_id, 'plan_updated',
      jsonb_build_object('kind', 'slot_added', 'item_id', new.id));
  elsif old.deleted_at is null and new.deleted_at is not null then
    -- A post leaving the plan by date is already announced by posts_plan_day_sync.
    if coalesce(current_setting('app.plan_day_sync', true), '') <> 'on' then
      perform public._plan_notify(new.plan_id, 'plan_updated',
        jsonb_build_object('kind', 'slot_removed', 'item_id', new.id, 'post_id', new.post_id, 'title', new.title));
    end if;
  elsif new.deleted_at is null and new.kind = 'concept'
        and (old.title is distinct from new.title or old.description is distinct from new.description) then
    perform public._plan_notify(new.plan_id, 'plan_updated',
      jsonb_build_object('kind', 'concept_changed', 'item_id', new.id));
  end if;
  return null;
end $function$
;

REVOKE ALL ON FUNCTION public._plan_items_change_notify() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._plans_rename_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public._plan_notify(new.id, 'plan_updated',
    jsonb_build_object('kind', 'renamed', 'from', old.title, 'to', new.title));
  return null;
end $function$
;

REVOKE ALL ON FUNCTION public._plans_rename_notify() FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261012161000 plus the app.plan_day_sync dedupe around the soft
-- delete. The plan_items.target_date update stays TRANSITIONAL, removed in 2b.
CREATE OR REPLACE FUNCTION public._posts_plan_day_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_new date; v_old date; v_out boolean;
begin
  for r in
    select i.id as item_id, i.plan_id, pl.starts_on, pl.ends_on, w.timezone as tz
      from public.plan_items i
      join public.plans pl on pl.id = i.plan_id and pl.deleted_at is null
      join public.workspaces w on w.id = i.workspace_id
     where i.post_id = new.id and i.kind = 'post' and i.deleted_at is null
  loop
    v_new := (new.target_date at time zone r.tz)::date;
    v_old := (old.target_date at time zone r.tz)::date;
    continue when v_new is not distinct from v_old;
    v_out := v_new is not null and v_new not between r.starts_on and r.ends_on;
    if v_out then
      perform set_config('app.plan_day_sync', 'on', true);
      update public.plan_items set deleted_at = now(), updated_at = now() where id = r.item_id;
      perform set_config('app.plan_day_sync', 'off', true);
    else
      update public.plan_items set target_date = v_new, updated_at = now() where id = r.item_id;  -- transitional mirror, removed in 2b
    end if;
    perform public._plan_notify(r.plan_id, 'plan_date_changed',
      jsonb_build_object('item_id', r.item_id, 'post_id', new.id, 'from', v_old, 'to', v_new, 'left_plan', v_out));
  end loop;
  return null;
end $function$
;

REVOKE ALL ON FUNCTION public._posts_plan_day_sync() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS plan_items_change_notify ON public.plan_items;
CREATE TRIGGER plan_items_change_notify AFTER INSERT OR UPDATE OF deleted_at, title, description ON public.plan_items FOR EACH ROW EXECUTE FUNCTION _plan_items_change_notify();

DROP TRIGGER IF EXISTS plans_rename_notify ON public.plans;
CREATE TRIGGER plans_rename_notify AFTER UPDATE OF title ON public.plans FOR EACH ROW WHEN (((old.title IS DISTINCT FROM new.title) AND (new.deleted_at IS NULL))) EXECUTE FUNCTION _plans_rename_notify();
