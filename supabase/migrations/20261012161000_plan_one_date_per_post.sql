-- Applied out of band 12 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- One date per post (Draft/Open wave, change 2a): a post slot's day is
-- posts.target_date (12:00 in the workspace zone). plan_items.target_date is
-- the day for concepts; for post slots it is a TRANSITIONAL mirror kept in
-- step by posts_plan_day_sync, removed in part 2b. Function bodies are
-- verbatim pg_get_functiondef from live.
--
-- _plan_notify is SILENT here (returns immediately), matching live until
-- part 2b restores the full body from 20261012160000_plan_notify_plumbing.sql.
--
-- Backfill: copies each live post slot's plan day onto its post; idempotent,
-- matches nothing once the dates agree. Runs before the trigger exists.
--
-- Rollback: drop trigger posts_plan_day_sync and function
-- public._posts_plan_day_sync(); drop plan_item_move(uuid, date, uuid[], boolean, uuid);
-- restore plan_item_move(uuid, date, uuid[], uuid) and plan_posts_add from
-- 20261012120000_plan_item_days.sql and plan_concept_add / plan_concept_edit
-- from 20261010120000_plan_items_concept_date.sql. Backfilled post dates are
-- not reverted (they were the plan days the UI already showed).

CREATE OR REPLACE FUNCTION public._plan_notify(p_plan_id uuid, p_event_type text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Silent until part 2b (screens PR merge) restores the body from change 1.
  return;
end $function$
;

REVOKE ALL ON FUNCTION public._plan_notify(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

UPDATE public.posts p
   SET target_date = ((i.target_date + time '12:00') AT TIME ZONE w.timezone),
       row_version = p.row_version + 1
  FROM public.plan_items i
  JOIN public.plans pl ON pl.id = i.plan_id AND pl.deleted_at IS NULL
  JOIN public.workspaces w ON w.id = i.workspace_id
 WHERE i.post_id = p.id AND i.kind = 'post' AND i.deleted_at IS NULL AND i.target_date IS NOT NULL
   AND p.deleted_at IS NULL
   AND (p.target_date IS NULL OR (p.target_date AT TIME ZONE w.timezone)::date <> i.target_date);

CREATE OR REPLACE FUNCTION public.plan_item_move(p_item_id uuid, p_target_date date, p_item_ids uuid[], p_keep_reviews boolean, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_plan uuid; v_start date; v_end date; v_tz text; v_kind text; v_post uuid;
        v_post_live boolean; v_old date; v_changed boolean;
begin
  select i.workspace_id, i.plan_id, pl.starts_on, pl.ends_on, w.timezone, i.kind, i.post_id, p.id is not null,
         case when i.kind = 'post' then (p.target_date at time zone w.timezone)::date else i.target_date end
    into v_ws, v_plan, v_start, v_end, v_tz, v_kind, v_post, v_post_live, v_old
    from public.plan_items i
    join public.plans pl on pl.id = i.plan_id
    join public.workspaces w on w.id = i.workspace_id
    left join public.posts p on p.id = i.post_id and p.deleted_at is null
   where i.id = p_item_id and i.deleted_at is null and pl.deleted_at is null
   for update of pl;
  if v_ws is null or p_keep_reviews is null then raise exception 'invalid_payload'; end if;
  if v_kind = 'post' and not v_post_live then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_target_date is not null and p_target_date not between v_start and v_end then raise exception 'date_outside_plan'; end if;
  if p_item_ids is null
     or cardinality(p_item_ids) <> (select count(*) from public.plan_items where plan_id = v_plan and deleted_at is null)
     or cardinality(p_item_ids) <> (select count(distinct x) from unnest(p_item_ids) x)
     or exists (select 1 from unnest(p_item_ids) x(id)
                 where not exists (select 1 from public.plan_items i
                                    where i.id = x.id and i.plan_id = v_plan and i.deleted_at is null)) then
    raise exception 'invalid_payload'; end if;
  v_changed := v_old is distinct from p_target_date;
  if v_changed then
    if v_kind = 'post' then
      -- posts_plan_day_sync notifies every plan holding this post.
      update public.posts
         set target_date = case when p_target_date is null then null
                                else (p_target_date + time '12:00') at time zone v_tz end,
             row_version = row_version + 1
       where id = v_post;
    else
      update public.plan_items set target_date = p_target_date, updated_at = now() where id = p_item_id;
      perform public._plan_notify(v_plan, 'plan_date_changed',
        jsonb_build_object('item_id', p_item_id, 'from', v_old, 'to', p_target_date, 'left_plan', false));
    end if;
    if not p_keep_reviews then
      update public.plan_item_reviews set status = 'waiting', reviewed_by = auth.uid(), reviewed_at = now()
       where item_id = p_item_id and status <> 'waiting';
    end if;
  end if;
  update public.plan_items i set position = u.ord - 1, updated_at = now()
    from unnest(p_item_ids) with ordinality u(id, ord) where i.id = u.id;
  perform public.audit_log_write(p_action=>'plan_item_move', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('from', v_old, 'to', p_target_date, 'day_changed', v_changed, 'reviews_kept', p_keep_reviews));
end $function$
;

REVOKE ALL ON FUNCTION public.plan_item_move(uuid, date, uuid[], boolean, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_move(uuid, date, uuid[], boolean, uuid) TO authenticated;

-- The 4-arg move stays for existing callers: a wrapper that resets reviews.
CREATE OR REPLACE FUNCTION public.plan_item_move(p_item_id uuid, p_target_date date, p_item_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.plan_item_move(p_item_id, p_target_date, p_item_ids, false, p_trace_id);
end $function$
;

REVOKE ALL ON FUNCTION public.plan_item_move(uuid, date, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_move(uuid, date, uuid[], uuid) TO authenticated;

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
    insert into public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by, target_date)
    select v_ws, p_plan_id, 'post', v_pos + x.ord - 1, x.id, auth.uid(),
           coalesce(p_target_date, (p.target_date at time zone v_tz)::date)  -- transitional mirror, cleared in 2b
      from (select distinct on (id) id, ord from unnest(p_post_ids) with ordinality u(id, ord) order by id, ord) x
      join public.posts p on p.id = x.id
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

REVOKE ALL ON FUNCTION public.plan_posts_add(uuid, uuid[], uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_posts_add(uuid, uuid[], uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.plan_concept_add(p_plan_id uuid, p_title text, p_description text, p_attachment_version_ids uuid[], p_trace_id uuid, p_target_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_id uuid; v_pos int; v_start date; v_end date;
begin
  select workspace_id, starts_on, ends_on into v_ws, v_start, v_end from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_target_date is not null and p_target_date not between v_start and v_end then raise exception 'date_outside_plan'; end if;
  perform public._plan_check_versions(v_ws, p_attachment_version_ids);
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  begin
    insert into public.plan_items (workspace_id, plan_id, kind, position, title, description, target_date, created_by)
    values (v_ws, p_plan_id, 'concept', v_pos, btrim(p_title), nullif(btrim(p_description), ''), p_target_date, auth.uid())
    returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public._plan_attach_versions(v_ws, v_id, p_attachment_version_ids);
  perform public.audit_log_write(p_action=>'plan_concept_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('plan_id', p_plan_id, 'attachments', coalesce(cardinality(p_attachment_version_ids), 0), 'target_date', p_target_date));
  return v_id;
end $function$
;

REVOKE ALL ON FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.plan_concept_edit(p_item_id uuid, p_title text, p_description text, p_attachment_version_ids uuid[], p_trace_id uuid, p_target_date date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text; v_plan uuid; v_start date; v_end date; v_old date;
begin
  select i.workspace_id, i.kind, i.plan_id, pl.starts_on, pl.ends_on, i.target_date
    into v_ws, v_kind, v_plan, v_start, v_end, v_old
    from public.plan_items i join public.plans pl on pl.id = i.plan_id and pl.deleted_at is null
   where i.id = p_item_id and i.deleted_at is null for update of i;
  if v_ws is null or v_kind <> 'concept' then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_target_date is not null and p_target_date not between v_start and v_end then raise exception 'date_outside_plan'; end if;
  begin
    update public.plan_items set title = btrim(p_title), description = nullif(btrim(p_description), ''),
           target_date = p_target_date, updated_at = now()
     where id = p_item_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  if p_attachment_version_ids is not null then
    perform public._plan_check_versions(v_ws, p_attachment_version_ids);
    update public.asset_attachments set deleted_at = now()
     where entity_type = 'plan_item' and entity_id = p_item_id::text and deleted_at is null;
    perform public._plan_attach_versions(v_ws, p_item_id, p_attachment_version_ids);
  end if;
  update public.plan_item_reviews set status = 'waiting', reviewed_by = auth.uid(), reviewed_at = now()
   where item_id = p_item_id and status <> 'waiting';
  if v_old is distinct from p_target_date then
    perform public._plan_notify(v_plan, 'plan_date_changed',
      jsonb_build_object('item_id', p_item_id, 'from', v_old, 'to', p_target_date, 'left_plan', false));
  end if;
  perform public.audit_log_write(p_action=>'plan_concept_edit', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('files_changed', p_attachment_version_ids is not null, 'target_date', p_target_date));
end $function$
;

REVOKE ALL ON FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid, date) TO authenticated;

-- Mirrors a post's day onto its plan slots. The plan_items.target_date update
-- for post slots is TRANSITIONAL, removed in part 2b. A date outside the plan
-- week soft-deletes the slot; a cleared date leaves the slot undated.
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
      update public.plan_items set deleted_at = now(), updated_at = now() where id = r.item_id;
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

DROP TRIGGER IF EXISTS posts_plan_day_sync ON public.posts;
CREATE TRIGGER posts_plan_day_sync AFTER UPDATE OF target_date ON public.posts FOR EACH ROW WHEN ((old.target_date IS DISTINCT FROM new.target_date)) EXECUTE FUNCTION _posts_plan_day_sync();
