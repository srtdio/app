-- Link a post any time (Shubham, 5 Nov 2026): plan_concept_link_post no longer
-- needs an OK on the concept (the concept_not_approved check is gone). Agency
-- side only, same workspace, live post, one concept per post per plan, as before.
-- Same signature and grants. Applied live via Supabase MCP on movnexawfhsyuluspxoc.

CREATE OR REPLACE FUNCTION public.plan_concept_link_post(p_item_id uuid, p_post_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text; v_old uuid;
begin
  select i.workspace_id, i.kind, i.linked_post_id into v_ws, v_kind, v_old
    from public.plan_items i join public.plans pl on pl.id = i.plan_id and pl.deleted_at is null
   where i.id = p_item_id and i.deleted_at is null for update of i;
  if v_ws is null or v_kind <> 'concept' then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_post_id is not null then
    if not exists (select 1 from public.posts p
                    where p.id = p_post_id and p.workspace_id = v_ws and p.deleted_at is null)
      then raise exception 'invalid_payload'; end if;
  end if;
  if v_old is not distinct from p_post_id then return; end if;
  begin
    update public.plan_items set linked_post_id = p_post_id, updated_at = now() where id = p_item_id;
  exception when unique_violation then raise exception 'post_already_linked';
  end;
  perform public.audit_log_write(p_action=>'plan_concept_link_post', p_outcome=>'success',
    p_trace_id=>p_trace_id, p_workspace_id=>v_ws, p_entity_type=>'plan_item',
    p_entity_id=>p_item_id::text, p_payload=>jsonb_build_object('from', v_old, 'to', p_post_id));
end $function$
;
REVOKE ALL ON FUNCTION public.plan_concept_link_post(p_item_id uuid, p_post_id uuid, p_trace_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.plan_concept_link_post(p_item_id uuid, p_post_id uuid, p_trace_id uuid) TO authenticated;
