-- Plan item days: every plan item (concept or post) carries the plan's own day
-- in plan_items.target_date; posts.target_date is never touched.
-- Applied live on movnexawfhsyuluspxoc (12 Oct); the function bodies below are
-- verbatim pg_get_functiondef (md5 plan_posts_add 3644c934a504c4729cab3606ada290a0,
-- plan_item_move 47ecd5f415306ac2dc5f5b3f6bdb9fee).
--
-- DESTRUCTIVE: drops constraint plan_items_target_date_concept_only (widens, no
-- data loss) and replaces plan_posts_add (3-arg -> 4-arg).
-- Rollback: set post items' target_date null, re-add CHECK (kind='concept' OR
-- target_date IS NULL), restore 3-arg plan_posts_add from the previous
-- migration, drop plan_item_move.
-- Live note: old 3-arg body was renamed into schema retired (MCP tool refuses
-- DROP); drop retired.plan_posts_add_retired_20261012 when convenient.

ALTER TABLE public.plan_items DROP CONSTRAINT plan_items_target_date_concept_only;

-- Post items take their post's day in the workspace zone.
UPDATE public.plan_items i
   SET target_date = (p.target_date AT TIME ZONE w.timezone)::date, updated_at = now()
  FROM public.posts p, public.workspaces w
 WHERE i.kind = 'post' AND i.post_id = p.id AND w.id = i.workspace_id
   AND i.deleted_at IS NULL AND p.target_date IS NOT NULL;

DROP FUNCTION public.plan_posts_add(uuid, uuid[], uuid);

CREATE OR REPLACE FUNCTION public.plan_posts_add(p_plan_id uuid, p_post_ids uuid[], p_trace_id uuid, p_target_date date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_start date; v_end date; v_tz text; v_pos int; v_added int;
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
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  insert into public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by, target_date)
  select v_ws, p_plan_id, 'post', v_pos + x.ord - 1, x.id, auth.uid(),
         coalesce(p_target_date,
           case when (p.target_date at time zone v_tz)::date between v_start and v_end
                then (p.target_date at time zone v_tz)::date end)
    from (select distinct on (id) id, ord from unnest(p_post_ids) with ordinality u(id, ord) order by id, ord) x
    join public.posts p on p.id = x.id
   where not exists (select 1 from public.plan_items i
                      where i.plan_id = p_plan_id and i.post_id = x.id and i.deleted_at is null);
  get diagnostics v_added = row_count;
  perform public.audit_log_write(p_action=>'plan_posts_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text,
    p_payload=>jsonb_build_object('added', v_added, 'target_date', p_target_date));
  return v_added;
end $function$
;

REVOKE ALL ON FUNCTION public.plan_posts_add(uuid, uuid[], uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_posts_add(uuid, uuid[], uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.plan_item_move(p_item_id uuid, p_target_date date, p_item_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_plan uuid; v_start date; v_end date; v_old date; v_changed boolean;
begin
  select i.workspace_id, i.plan_id, pl.starts_on, pl.ends_on, i.target_date
    into v_ws, v_plan, v_start, v_end, v_old
    from public.plan_items i join public.plans pl on pl.id = i.plan_id
   where i.id = p_item_id and i.deleted_at is null and pl.deleted_at is null
   for update of pl;
  if v_ws is null then raise exception 'invalid_payload'; end if;
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
    update public.plan_items set target_date = p_target_date, updated_at = now() where id = p_item_id;
    update public.plan_item_reviews set status = 'waiting', reviewed_by = auth.uid(), reviewed_at = now()
     where item_id = p_item_id and status <> 'waiting';
  end if;
  update public.plan_items i set position = u.ord - 1, updated_at = now()
    from unnest(p_item_ids) with ordinality u(id, ord) where i.id = u.id;
  perform public.audit_log_write(p_action=>'plan_item_move', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('from', v_old, 'to', p_target_date, 'day_changed', v_changed));
end $function$
;

REVOKE ALL ON FUNCTION public.plan_item_move(uuid, date, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_move(uuid, date, uuid[], uuid) TO authenticated;
