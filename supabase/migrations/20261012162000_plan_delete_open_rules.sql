-- Applied out of band 12 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- Plan delete and open rules (Draft/Open wave, change 3): plan_delete is
-- limited to the plan's creator or a workspace owner/admin and notifies
-- plan_deleted; plan_share_with_client notifies plan_opened. Both via
-- _plan_notify (silent on live until part 2b). Function bodies are verbatim
-- pg_get_functiondef from live.
--
-- Rollback: restore plan_delete and plan_share_with_client from
-- 20261009110000_plans_core.sql (any agency-side member deletes, no notify).

CREATE OR REPLACE FUNCTION public.plan_delete(p_plan_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_creator uuid;
begin
  select workspace_id, created_by into v_ws, v_creator from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if v_creator is distinct from auth.uid() and not exists (
       select 1 from public.workspace_members wm
        where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true
          and wm.role = any (array['owner','admin'])) then
    raise exception 'forbidden_role'; end if;
  update public.plans set deleted_at = now(), updated_at = now() where id = p_plan_id;
  perform public._plan_notify(p_plan_id, 'plan_deleted', '{}'::jsonb);
  perform public.audit_log_write(p_action=>'plan_delete', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text, p_payload=>'{}'::jsonb);
end $function$
;

REVOKE ALL ON FUNCTION public.plan_delete(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_delete(uuid, uuid) TO authenticated;

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
  perform public._plan_notify(p_plan_id, 'plan_opened', '{}'::jsonb);
  perform public.audit_log_write(p_action=>'plan_share_with_client', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text, p_payload=>'{}'::jsonb);
end $function$
;

REVOKE ALL ON FUNCTION public.plan_share_with_client(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_share_with_client(uuid, uuid) TO authenticated;
