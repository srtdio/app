-- Applied live 23 Oct 2026 06:52 IST via MCP. Do NOT execute.
-- brief_reopen: any active workspace member returns a closed brief to open (no capability check, product decision).
-- Body copied verbatim from live pg_get_functiondef.
-- event_type 'system' + payload.kind 'brief_reopened' avoids replacing the inbox_entries_event_type_check constraint.
CREATE OR REPLACE FUNCTION public.brief_reopen(p_brief_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_status text; v_title text; v_number integer; v_role text; v_uid uuid := auth.uid();
BEGIN
  PERFORM set_config('app.trace_id', p_trace_id::text, true);
  SELECT workspace_id, status, title, number INTO v_ws, v_status, v_title, v_number
    FROM public.briefs WHERE id = p_brief_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_status <> 'closed' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = v_uid AND wm.active = true;
  UPDATE public.briefs SET status = 'open', closed_at = NULL, closed_by = NULL, row_version = row_version + 1
   WHERE id = p_brief_id;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id,
                                    scope, scope_key, tier, payload, actor_user_id)
  SELECT m.user_id, v_ws, 'system', 'brief', p_brief_id::text, 'briefs', NULL, 'active',
         jsonb_build_object('kind','brief_reopened','title',v_title,'number',v_number,'actor_role',v_role), v_uid
    FROM public.workspace_members m
   WHERE m.workspace_id = v_ws AND m.active AND m.user_id <> v_uid;
  PERFORM public.inbox_self_entry(v_ws, 'system', 'brief', p_brief_id::text, 'briefs', NULL,
    jsonb_build_object('kind','brief_reopened','title',v_title,'number',v_number,'actor_role',v_role));
  PERFORM public.audit_log_write('brief_reopen','success',p_trace_id,v_ws,'brief',p_brief_id::text,NULL);
END; $function$;

REVOKE ALL ON FUNCTION public.brief_reopen(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.brief_reopen(uuid, uuid) TO authenticated;
