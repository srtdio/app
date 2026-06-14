-- ALREADY APPLIED to movnexawfhsyuluspxoc via MCP. Do NOT execute. Do NOT run supabase db push.
-- Activity write path: per-user read-state + snooze. User-callable SECURITY DEFINER procs.
CREATE OR REPLACE FUNCTION public.inbox_mark_read(
  p_entry_id uuid, p_workspace_id uuid, p_created_at timestamptz, p_trace_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_n int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.inbox_entries SET read_at = now()
   WHERE id = p_entry_id AND workspace_id = p_workspace_id AND user_id = auth.uid()
     AND created_at >= date_trunc('month', p_created_at)
     AND created_at <  date_trunc('month', p_created_at) + interval '1 month'
     AND read_at IS NULL AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_mark_read','success',p_trace_id,p_workspace_id,'inbox_entry',p_entry_id::text,'{}'::jsonb);
  END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.inbox_mark_all_read(
  p_workspace_id uuid, p_trace_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_n int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.inbox_entries SET read_at = now()
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
     AND read_at IS NULL AND snoozed_until IS NULL AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_mark_all_read','success',p_trace_id,p_workspace_id,'inbox_entry',NULL::text,jsonb_build_object('count',v_n));
  END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.inbox_snooze(
  p_entry_id uuid, p_workspace_id uuid, p_created_at timestamptz, p_kind text, p_trace_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_tz text; v_local timestamp; v_until timestamptz; v_n int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_kind NOT IN ('1h','4h','tomorrow_9','next_week','clear') THEN RAISE EXCEPTION 'invalid_snooze_kind'; END IF;
  SELECT timezone INTO v_tz FROM public.workspaces WHERE id = p_workspace_id;
  v_tz := coalesce(v_tz,'UTC');
  v_local := now() AT TIME ZONE v_tz;
  v_until := CASE p_kind
    WHEN '1h'         THEN now() + interval '1 hour'
    WHEN '4h'         THEN now() + interval '4 hours'
    WHEN 'tomorrow_9' THEN (date_trunc('day',  v_local) + interval '1 day 9 hours')  AT TIME ZONE v_tz
    WHEN 'next_week'  THEN (date_trunc('week', v_local) + interval '1 week 9 hours') AT TIME ZONE v_tz
    ELSE NULL
  END;
  UPDATE public.inbox_entries SET snoozed_until = v_until
   WHERE id = p_entry_id AND workspace_id = p_workspace_id AND user_id = auth.uid()
     AND created_at >= date_trunc('month', p_created_at)
     AND created_at <  date_trunc('month', p_created_at) + interval '1 month'
     AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_snooze','success',p_trace_id,p_workspace_id,'inbox_entry',p_entry_id::text,jsonb_build_object('kind',p_kind));
  END IF;
END; $function$;

REVOKE ALL ON FUNCTION public.inbox_mark_read(uuid,uuid,timestamptz,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbox_mark_all_read(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbox_snooze(uuid,uuid,timestamptz,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inbox_mark_read(uuid,uuid,timestamptz,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_mark_all_read(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_snooze(uuid,uuid,timestamptz,text,uuid) TO authenticated;
