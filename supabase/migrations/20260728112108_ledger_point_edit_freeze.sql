-- Record of a change already applied to the live database via MCP (2026-07-28).
-- Idempotent. Safe under db push. Do NOT re-apply manually.
-- Contents: comment_edit / comment_soft_delete are author-only, require an active
-- workspace member, and now RAISE 'checkpoint_frozen' when the target is a ledger
-- point (ledger_seq set) that is confirmed (accepted_at) or locked by post approval
-- (closed_at). comment_edit no longer clears accepted_at/accepted_by/closed_at/
-- closed_by; both procs record body_before (and body_after on edit) in the audit log.
-- Grants are unchanged and already correct, so none are re-issued here.

CREATE OR REPLACE FUNCTION public.comment_edit(p_comment_id uuid, p_body text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ledger int; v_words int; v_old_body text;
        v_accepted timestamptz; v_closed timestamptz;
BEGIN
  SELECT workspace_id, ledger_seq, body, accepted_at, closed_at
    INTO v_ws, v_ledger, v_old_body, v_accepted, v_closed
  FROM public.comments
   WHERE id = p_comment_id AND author_user_id = auth.uid() AND deleted_at IS NULL
   FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_ledger IS NOT NULL AND (v_accepted IS NOT NULL OR v_closed IS NOT NULL) THEN
    RAISE EXCEPTION 'checkpoint_frozen';
  END IF;
  IF p_body IS NULL OR length(p_body) < 1 OR length(p_body) > 10000 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF v_ledger IS NOT NULL THEN
    v_words := coalesce(array_length(regexp_split_to_array(btrim(p_body), '\s+'), 1), 0);
    IF v_words < 1 OR v_words > 50 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  UPDATE public.comments SET
    body = p_body,
    edited_at = now(),
    resolved_at         = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolved_at END,
    resolved_by         = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolved_by END,
    resolution_note     = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolution_note END,
    resolved_version_id = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolved_version_id END,
    asked_at            = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE asked_at END,
    asked_by            = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE asked_by END,
    sent_back_at        = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE sent_back_at END,
    sent_back_by        = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE sent_back_by END
  WHERE id = p_comment_id;
  PERFORM public.audit_log_write('comment_edit', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text,
          jsonb_build_object('checkpoint', v_ledger IS NOT NULL,
                             'body_before', v_old_body, 'body_after', p_body));
  RETURN p_comment_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.comment_soft_delete(p_comment_id uuid, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ledger int; v_accepted timestamptz; v_closed timestamptz; v_old_body text;
BEGIN
  SELECT workspace_id, ledger_seq, accepted_at, closed_at, body
    INTO v_ws, v_ledger, v_accepted, v_closed, v_old_body
  FROM public.comments
   WHERE id = p_comment_id AND author_user_id = auth.uid() AND deleted_at IS NULL
   FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_ledger IS NOT NULL AND (v_accepted IS NOT NULL OR v_closed IS NOT NULL) THEN
    RAISE EXCEPTION 'checkpoint_frozen';
  END IF;
  UPDATE public.comments SET deleted_at = now() WHERE id = p_comment_id;
  PERFORM public.audit_log_write('comment_soft_delete','success',p_trace_id,v_ws,'comment',
    p_comment_id::text,
    jsonb_build_object('checkpoint', v_ledger IS NOT NULL, 'body_before', v_old_body));
  RETURN p_comment_id;
END; $function$;
