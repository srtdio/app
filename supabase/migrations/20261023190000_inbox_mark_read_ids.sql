-- inbox_mark_read_ids: mark a batch (1 to 500) of the caller's own entries read
-- in one call, for a chip's Mark all read (Mentions, Briefs, Plans) across rows
-- the page has not loaded. Same row rules as inbox_mark_all_read: unread, not
-- deleted, and not snoozed (or a snooze that has run out). Audits the count.
-- Applied 23 Oct 2026 via Supabase MCP; this file records it verbatim.

CREATE OR REPLACE FUNCTION public.inbox_mark_read_ids(p_workspace_id uuid, p_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_n int;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.inbox_entries SET read_at = now()
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid() AND id = ANY(p_ids)
     AND read_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now()) AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_mark_read_ids','success',p_trace_id,p_workspace_id,'inbox_entry',NULL::text,jsonb_build_object('count',v_n));
  END IF;
END; $function$;

REVOKE ALL ON FUNCTION public.inbox_mark_read_ids(uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_mark_read_ids(uuid, uuid[], uuid) TO authenticated;
