-- Applied out of band 11 Oct 2026 (plan drafts in client plans). No-op on movnexawfhsyuluspxoc.
--
-- Restates live exactly (pg_get_functiondef):
--   plan_share_with_client: the plan_has_drafts check is gone; a plan with
--     drafts inside can be shared. Still agency-side only, one-way, audited.
--   plan_posts_add: a draft post can be added to a client plan; the
--     plan_has_drafts check is gone. Everything else unchanged.
--   plan_draft_items (new): read-only helper returning the plan's live post
--     items whose post is stage 'draft' (number, title, target date). Empty
--     when the plan is missing or deleted, the caller is not an active member,
--     or the plan is 'team' and the caller is not agency-side. Lets a client
--     see draft rows in a client plan without posts SELECT on the draft.
--     Retired the same day in favour of the batched plan_draft_rows: no
--     EXECUTE for anyone (owner only); the drop is pending a later cleanup.
--   plan_draft_rows (new): batched read-only helper; the same draft rows
--     plus plan_id for up to 100 plan ids. Empty or null list returns
--     nothing; more than 100 ids is invalid_payload. Per plan: not deleted,
--     caller an active member of its workspace, and the plan is 'client' or
--     the caller is agency-side. Unknown or invisible ids return nothing.
-- Privileges mirror live: plan_draft_rows EXECUTE to authenticated only;
-- plan_draft_items owner-only. No DROP.

CREATE OR REPLACE FUNCTION public.plan_share_with_client(p_plan_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text;
begin
  select workspace_id, audience into v_ws, v_aud from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if v_aud = 'client' then return; end if;
  update public.plans set audience = 'client', shared_with_client_at = now(), shared_with_client_by = auth.uid(),
                          updated_at = now()
   where id = p_plan_id;
  perform public.audit_log_write(p_action=>'plan_share_with_client', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text, p_payload=>'{}'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.plan_posts_add(p_plan_id uuid, p_post_ids uuid[], p_trace_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_pos int; v_added int;
begin
  select workspace_id, audience into v_ws, v_aud from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_post_ids is null or cardinality(p_post_ids) not between 1 and 50 then raise exception 'invalid_payload'; end if;
  if exists (select 1 from unnest(p_post_ids) x(id)
             left join public.posts p on p.id = x.id and p.workspace_id = v_ws and p.deleted_at is null
             where p.id is null) then raise exception 'invalid_payload'; end if;
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  insert into public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by)
  select v_ws, p_plan_id, 'post', v_pos + x.ord - 1, x.id, auth.uid()
    from (select distinct on (id) id, ord from unnest(p_post_ids) with ordinality u(id, ord) order by id, ord) x
   where not exists (select 1 from public.plan_items i
                      where i.plan_id = p_plan_id and i.post_id = x.id and i.deleted_at is null);
  get diagnostics v_added = row_count;
  perform public.audit_log_write(p_action=>'plan_posts_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text,
    p_payload=>jsonb_build_object('added', v_added));
  return v_added;
end $function$;

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
    select i.id, i.position, p.number, p.title, p.target_date
      from public.plan_items i join public.posts p on p.id = i.post_id
     where i.plan_id = p_plan_id and i.deleted_at is null and i.kind = 'post'
       and p.deleted_at is null and p.stage = 'draft';
end $function$;

-- Retired 11 Oct 2026 (superseded by plan_draft_rows); drop pending.
REVOKE ALL ON FUNCTION public.plan_draft_items(uuid) FROM PUBLIC, anon, authenticated, service_role;

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
end $function$;

REVOKE ALL ON FUNCTION public.plan_draft_rows(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_draft_rows(uuid[]) TO authenticated;
