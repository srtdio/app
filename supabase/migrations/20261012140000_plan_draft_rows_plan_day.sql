-- Proc bodies only; draft rows use the plan's day (UTC midnight, same convention as posts.target_date). Rollback: previous bodies returned p.target_date.
-- Applied live on movnexawfhsyuluspxoc (12 Oct); the bodies below are verbatim
-- pg_get_functiondef (md5 plan_draft_items fcc8fc1b4fa80f417c55e9a504b9a9b2,
-- plan_draft_rows 04702684d90c9211b6460f3fd3fe1a75). Grants unchanged.

CREATE OR REPLACE FUNCTION public.plan_draft_items(p_plan_id uuid)
 RETURNS TABLE(item_id uuid, item_position integer, post_number integer, title text, target_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text;
begin
  select workspace_id, audience into v_ws, v_aud from public.plans where id = p_plan_id and deleted_at is null;
  if v_ws is null or not public.is_active_workspace_member(v_ws) then return; end if;
  if v_aud = 'team' and not public.is_agency_side_member(v_ws) then return; end if;
  return query
    select i.id, i.position, p.number, p.title, (i.target_date::timestamp at time zone 'UTC')
      from public.plan_items i join public.posts p on p.id = i.post_id
     where i.plan_id = p_plan_id and i.deleted_at is null and i.kind = 'post'
       and p.deleted_at is null and p.stage = 'draft';
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
    select i.plan_id, i.id, i.position, p.number, p.title, (i.target_date::timestamp at time zone 'UTC')
      from public.plans pl
      join public.plan_items i on i.plan_id = pl.id and i.deleted_at is null and i.kind = 'post'
      join public.posts p on p.id = i.post_id and p.deleted_at is null and p.stage = 'draft'
     where pl.id = any (p_plan_ids) and pl.deleted_at is null
       and public.is_active_workspace_member(pl.workspace_id)
       and (pl.audience = 'client' or public.is_agency_side_member(pl.workspace_id));
end $function$
;
