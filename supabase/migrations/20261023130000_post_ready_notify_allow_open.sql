-- Post flow B fix round: "Send for review again" is never blocked by open
-- comments. Rebuilt from the LIVE body of public.post_ready_notify with two
-- changes only: the checkpoints_open guard is removed, and the inbox payloads
-- carry 'open' (open checkpoint count) next to 'checkpoints'.
-- Signature and return type unchanged; CREATE OR REPLACE keeps grants.

CREATE OR REPLACE FUNCTION public.post_ready_notify(p_post_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_stage text; v_open int; v_total int;
BEGIN
  SELECT workspace_id, stage INTO v_ws, v_stage FROM public.posts WHERE id = p_post_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role IN ('owner','admin','agency')) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF v_stage <> 'review' THEN RAISE EXCEPTION 'invalid_stage'; END IF;
  SELECT count(*) FILTER (WHERE resolved_at IS NULL), count(*) INTO v_open, v_total
  FROM public.comments
  WHERE entity_type = 'post' AND entity_id = p_post_id
    AND ledger_seq IS NOT NULL AND deleted_at IS NULL;
  INSERT INTO public.post_ready_notifications (workspace_id, post_id, sent_by, checkpoint_count)
  VALUES (v_ws, p_post_id, auth.uid(), v_total);
  INSERT INTO public.inbox_entries
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'post_ready', 'post', p_post_id::text, 'posts', p_post_id::text,
         'urgent', jsonb_build_object('checkpoints', v_total, 'open', v_open), auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.role = 'client'
    AND wm.user_id <> auth.uid();
  PERFORM public.inbox_self_entry(v_ws, 'post_ready', 'post', p_post_id::text, 'posts', p_post_id::text,
    jsonb_build_object('checkpoints', v_total, 'open', v_open));
  PERFORM public.audit_log_write('post_ready_notify', 'success', p_trace_id, v_ws, 'post',
          p_post_id::text, jsonb_build_object('checkpoints', v_total));
END; $function$;
