-- Applied live 22 Oct 2026 via MCP. Do NOT execute.
-- inbox_mark_all_read covers every event type (no bell/chat-mention exclusions); snoozed rows stay unread.
CREATE OR REPLACE FUNCTION public.inbox_mark_all_read(p_workspace_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
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
