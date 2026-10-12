-- Applied on movnexawfhsyuluspxoc after this PR merged (part 2b). No-op there once applied.
--
-- Plan Draft/Open wave, part 2b: _plan_notify sends alerts only for plans open
-- to the client (plan_deleted always) and adds plan_title to every payload;
-- post slots carry no day of their own (posts.target_date is the day):
-- plan_posts_add no longer writes plan_items.target_date, _posts_plan_day_sync
-- drops its transitional mirror, plan_draft_rows returns p.target_date; the
-- post slots' leftover days are cleared and a CHECK keeps target_date to
-- concepts. The 4-arg plan_item_move overload stays as an unused wrapper.
-- The three proc bodies are copies of 20261012161000 (plan_posts_add),
-- 20261012163000 (_posts_plan_day_sync) and 20261012140000 (plan_draft_rows)
-- with only the stated change. Grants unchanged (CREATE OR REPLACE keeps them).
-- inbox_mark_all_read (Activity "Mark all read") now also skips the plan bell
-- types (same list as BELL_PLAN_EVENT_TYPES in src/lib/inbox/bell-types.ts;
-- bell-types.test.ts asserts its NOT IN list covers BELL_ONLY_EVENT_TYPES).
--
-- Rollback: ALTER TABLE public.plan_items DROP CONSTRAINT
-- plan_items_target_date_concept_only; restore _plan_notify (silent) from
-- 20261012161000_plan_one_date_per_post.sql, plan_posts_add from
-- 20261012161000_plan_one_date_per_post.sql, _posts_plan_day_sync from
-- 20261012163000_plan_updated_alerts.sql and plan_draft_rows from
-- 20261012140000_plan_draft_rows_plan_day.sql, inbox_mark_all_read from
-- 20261003160000_inbox_mark_all_read_skip_bell.sql; re-backfill post slot days with
-- UPDATE plan_items i SET target_date = (p.target_date AT TIME ZONE w.timezone)::date
-- FROM posts p, workspaces w WHERE i.kind = 'post' AND p.id = i.post_id AND w.id = i.workspace_id.

--BEGIN 2b
CREATE OR REPLACE FUNCTION public._plan_notify(p_plan_id uuid, p_event_type text, p_payload jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_title text;
begin
  select workspace_id, audience, title into v_ws, v_aud, v_title from public.plans where id = p_plan_id;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if v_aud = 'team' and p_event_type <> 'plan_deleted' then return; end if;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, p_event_type, 'plan', p_plan_id::text, 'posts', p_plan_id::text, 'active',
         coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('plan_id', p_plan_id, 'plan_title', v_title), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.active = true
     and wm.user_id is distinct from auth.uid()
     and (wm.role = any (array['owner','admin','agency']) or (v_aud = 'client' and wm.role = 'client'));
end $function$;

CREATE OR REPLACE FUNCTION public.plan_posts_add(p_plan_id uuid, p_post_ids uuid[], p_trace_id uuid, p_target_date date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_start date; v_end date; v_tz text; v_pos int; v_added int; v_ids uuid[];
begin
  select pl.workspace_id, pl.starts_on, pl.ends_on, w.timezone into v_ws, v_start, v_end, v_tz
    from public.plans pl join public.workspaces w on w.id = pl.workspace_id
   where pl.id = p_plan_id and pl.deleted_at is null for update of pl;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_post_ids is null or cardinality(p_post_ids) not between 1 and 50 then raise exception 'invalid_payload'; end if;
  if p_target_date is not null and p_target_date not between v_start and v_end then raise exception 'date_outside_plan'; end if;
  if exists (select 1 from unnest(p_post_ids) x(id)
             left join public.posts p on p.id = x.id and p.workspace_id = v_ws and p.deleted_at is null
             where p.id is null) then raise exception 'invalid_payload'; end if;
  if p_target_date is null and exists (
       select 1 from unnest(p_post_ids) x(id) join public.posts p on p.id = x.id
        where p.target_date is not null
          and (p.target_date at time zone v_tz)::date not between v_start and v_end) then
    raise exception 'date_outside_plan'; end if;
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  with ins as (
    insert into public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by)
    select v_ws, p_plan_id, 'post', v_pos + x.ord - 1, x.id, auth.uid()
      from (select distinct on (id) id, ord from unnest(p_post_ids) with ordinality u(id, ord) order by id, ord) x
     where not exists (select 1 from public.plan_items i
                        where i.plan_id = p_plan_id and i.post_id = x.id and i.deleted_at is null)
    returning post_id)
  select array_agg(post_id) into v_ids from ins;
  v_added := coalesce(cardinality(v_ids), 0);
  if p_target_date is not null and v_added > 0 then
    update public.posts
       set target_date = (p_target_date + time '12:00') at time zone v_tz, row_version = row_version + 1
     where id = any (v_ids)
       and (target_date is null or (target_date at time zone v_tz)::date <> p_target_date);
  end if;
  perform public.audit_log_write(p_action=>'plan_posts_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text,
    p_payload=>jsonb_build_object('added', v_added, 'target_date', p_target_date));
  return v_added;
end $function$
;

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
    end if;
    perform public._plan_notify(r.plan_id, 'plan_date_changed',
      jsonb_build_object('item_id', r.item_id, 'post_id', new.id, 'from', v_old, 'to', v_new, 'left_plan', v_out));
  end loop;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.plan_draft_rows(p_plan_ids uuid[])
 RETURNS TABLE(plan_id uuid, item_id uuid, item_position integer, post_number integer, title text, target_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_plan_ids is null or cardinality(p_plan_ids) = 0 then return; end if;
  if cardinality(p_plan_ids) > 100 then raise exception 'invalid_payload'; end if;
  return query
    select i.plan_id, i.id, i.position, p.number, p.title, p.target_date
      from public.plans pl
      join public.plan_items i on i.plan_id = pl.id and i.deleted_at is null and i.kind = 'post'
      join public.posts p on p.id = i.post_id and p.deleted_at is null and p.stage = 'draft'
     where pl.id = any (p_plan_ids) and pl.deleted_at is null
       and public.is_active_workspace_member(pl.workspace_id)
       and (pl.audience = 'client' or public.is_agency_side_member(pl.workspace_id));
end $function$
;

UPDATE public.plan_items SET target_date = NULL, updated_at = now() WHERE kind = 'post' AND target_date IS NOT NULL;

ALTER TABLE public.plan_items ADD CONSTRAINT plan_items_target_date_concept_only CHECK (kind = 'concept' OR target_date IS NULL);
--END 2b

--BEGIN 2b inbox_mark_all_read
CREATE OR REPLACE FUNCTION public.inbox_mark_all_read(p_workspace_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_n int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.inbox_entries SET read_at = now()
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
     AND read_at IS NULL AND snoozed_until IS NULL AND deleted_at IS NULL
     AND event_type NOT IN ('reminder','scheduled_sent','scheduled_failed',
                            'plan_opened','plan_deleted','plan_date_changed','plan_updated','plan_review','plan_comment')
     AND NOT (event_type = 'mention' AND entity_type = 'chat_channel');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_mark_all_read','success',p_trace_id,p_workspace_id,'inbox_entry',NULL::text,jsonb_build_object('count',v_n));
  END IF;
END; $function$;
--END 2b
