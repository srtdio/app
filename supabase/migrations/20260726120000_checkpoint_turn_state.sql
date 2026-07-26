-- Checkpoint turn state: who holds the ball on each ledger point.
-- Already applied to the live database via MCP on 2026-07-26. Written
-- idempotently so a replay against live is a no-op and a fresh container
-- builds the same objects.

ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS asked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS asked_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_back_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_back_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.comments'::regclass
                   AND conname = 'comments_turn_requires_checkpoint') THEN
    ALTER TABLE public.comments
      ADD CONSTRAINT comments_turn_requires_checkpoint CHECK (
        ledger_seq IS NOT NULL
        OR (asked_at IS NULL AND sent_back_at IS NULL AND closed_at IS NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.comments'::regclass
                   AND conname = 'comments_closed_xor_accepted') THEN
    ALTER TABLE public.comments
      ADD CONSTRAINT comments_closed_xor_accepted CHECK (
        closed_at IS NULL OR accepted_at IS NULL
      );
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS comments_ledger_live_idx
  ON public.comments (entity_id, ledger_seq)
  WHERE ledger_seq IS NOT NULL AND deleted_at IS NULL AND closed_at IS NULL;

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'comment','mention','stage_change','comment_resolved','brief_created',
    'brief_closed','asset_uploaded','asset_version_added','invite',
    'trial_warning','billing_failure','system','checkpoints_added',
    'post_ready','checkpoint_reopened','checkpoint_asked']));

CREATE OR REPLACE FUNCTION public.checkpoint_send_back(
  p_comment_id uuid, p_body text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ws uuid; v_seq int; v_deleted timestamptz;
        v_entity_type text; v_entity_id uuid; v_reply uuid; v_words int;
BEGIN
  SELECT workspace_id, ledger_seq, deleted_at, entity_type, entity_id
    INTO v_ws, v_seq, v_deleted, v_entity_type, v_entity_id
  FROM public.comments WHERE id = p_comment_id FOR UPDATE;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_seq IS NULL OR v_entity_type <> 'post' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  v_words := array_length(regexp_split_to_array(btrim(coalesce(p_body,'')),'\s+'),1);
  IF p_body IS NULL OR v_words IS NULL OR v_words < 1 OR v_words > 50
     OR char_length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  INSERT INTO public.comments (workspace_id, entity_type, entity_id,
    parent_comment_id, author_user_id, body)
  VALUES (v_ws, v_entity_type, v_entity_id, p_comment_id, auth.uid(), p_body)
  RETURNING id INTO v_reply;

  UPDATE public.comments
     SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL,
         resolved_version_id = NULL, accepted_at = NULL, accepted_by = NULL,
         asked_at = NULL, asked_by = NULL, closed_at = NULL, closed_by = NULL,
         sent_back_at = now(), sent_back_by = auth.uid()
   WHERE id = p_comment_id;

  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type,
    entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'checkpoint_reopened', 'post', v_entity_id::text,
         'posts', v_entity_id::text, 'urgent',
         jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq, 'reply_id', v_reply)
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true
    AND wm.role IN ('owner','admin','agency') AND wm.user_id <> auth.uid();

  PERFORM public.audit_log_write('checkpoint_send_back','success',p_trace_id,v_ws,
    'comment', p_comment_id::text, jsonb_build_object('seq',v_seq,'reply_id',v_reply));
  RETURN v_reply;
END; $$;

CREATE OR REPLACE FUNCTION public.checkpoint_ask(
  p_comment_id uuid, p_body text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ws uuid; v_seq int; v_deleted timestamptz;
        v_entity_type text; v_entity_id uuid; v_reply uuid; v_words int;
BEGIN
  SELECT workspace_id, ledger_seq, deleted_at, entity_type, entity_id
    INTO v_ws, v_seq, v_deleted, v_entity_type, v_entity_id
  FROM public.comments WHERE id = p_comment_id FOR UPDATE;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_seq IS NULL OR v_entity_type <> 'post' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role IN ('owner','admin','agency')) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  v_words := array_length(regexp_split_to_array(btrim(coalesce(p_body,'')),'\s+'),1);
  IF p_body IS NULL OR v_words IS NULL OR v_words < 1 OR v_words > 50
     OR char_length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  INSERT INTO public.comments (workspace_id, entity_type, entity_id,
    parent_comment_id, author_user_id, body)
  VALUES (v_ws, v_entity_type, v_entity_id, p_comment_id, auth.uid(), p_body)
  RETURNING id INTO v_reply;

  UPDATE public.comments
     SET asked_at = now(), asked_by = auth.uid(),
         sent_back_at = NULL, sent_back_by = NULL
   WHERE id = p_comment_id;

  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type,
    entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'checkpoint_asked', 'post', v_entity_id::text,
         'posts', v_entity_id::text, 'urgent',
         jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq, 'reply_id', v_reply)
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true
    AND wm.role = 'client' AND wm.user_id <> auth.uid();

  PERFORM public.audit_log_write('checkpoint_ask','success',p_trace_id,v_ws,
    'comment', p_comment_id::text, jsonb_build_object('seq',v_seq,'reply_id',v_reply));
  RETURN v_reply;
END; $$;

CREATE OR REPLACE FUNCTION public.checkpoint_accept(
  p_comment_id uuid, p_accepted boolean, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ws uuid; v_seq int; v_deleted timestamptz; v_rows int := 0;
BEGIN
  SELECT workspace_id, ledger_seq, deleted_at
    INTO v_ws, v_seq, v_deleted
  FROM public.comments WHERE id = p_comment_id FOR UPDATE;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_accepted THEN
    UPDATE public.comments
       SET resolved_at = coalesce(resolved_at, now()),
           resolved_by = coalesce(resolved_by, auth.uid()),
           accepted_at = now(), accepted_by = auth.uid(),
           unaccepted_at = NULL, unaccepted_by = NULL,
           asked_at = NULL, asked_by = NULL,
           sent_back_at = NULL, sent_back_by = NULL,
           closed_at = NULL, closed_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL AND accepted_at IS NULL;
  ELSE
    UPDATE public.comments
       SET accepted_at = NULL, accepted_by = NULL,
           unaccepted_at = now(), unaccepted_by = auth.uid()
     WHERE id = p_comment_id AND deleted_at IS NULL AND accepted_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.audit_log_write('checkpoint_accept','success',p_trace_id,v_ws,'comment',
    p_comment_id::text, jsonb_build_object('accepted',p_accepted,'transitioned',v_rows > 0));
END; $$;

CREATE OR REPLACE FUNCTION public.comment_resolve(
  p_comment_id uuid, p_resolved boolean, p_trace_id uuid,
  p_resolution_note text DEFAULT NULL::text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ws uuid; v_entity_type text; v_entity_id uuid; v_parent uuid;
        v_deleted timestamptz; v_scope text; v_is_draft boolean := false;
        v_brief_owner uuid; v_rows int := 0; v_note text; v_version_id uuid;
        v_seq int;
BEGIN
  IF p_resolution_note IS NOT NULL AND char_length(p_resolution_note) > 500 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  v_note := nullif(btrim(coalesce(p_resolution_note, '')), '');
  SELECT workspace_id, entity_type, entity_id, parent_comment_id, deleted_at, ledger_seq
    INTO v_ws, v_entity_type, v_entity_id, v_parent, v_deleted, v_seq
  FROM public.comments WHERE id = p_comment_id;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_parent IS NOT NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_resolved AND NOT EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
         AND wm.active = true AND wm.role IN ('owner','admin','agency')) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF p_resolved THEN
    IF v_entity_type = 'post' THEN
      SELECT id INTO v_version_id FROM public.post_versions
       WHERE post_id = v_entity_id ORDER BY version_number DESC LIMIT 1;
    END IF;
    UPDATE public.comments
       SET resolved_at = now(), resolved_by = auth.uid(), resolution_note = v_note,
           resolved_version_id = v_version_id,
           asked_at = NULL, asked_by = NULL,
           sent_back_at = NULL, sent_back_by = NULL,
           closed_at = NULL, closed_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NULL;
  ELSE
    UPDATE public.comments
       SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL,
           resolved_version_id = NULL,
           accepted_at = NULL, accepted_by = NULL,
           closed_at = NULL, closed_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_entity_type = 'post' THEN
    v_scope := 'posts';
    SELECT (stage = 'draft') INTO v_is_draft FROM public.posts WHERE id = v_entity_id;
    v_is_draft := coalesce(v_is_draft, false);
  ELSE
    v_scope := 'briefs';
    SELECT created_by INTO v_brief_owner FROM public.briefs WHERE id = v_entity_id;
  END IF;
  IF p_resolved AND v_rows > 0 THEN
    INSERT INTO public.inbox_entries
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
    SELECT DISTINCT wm.user_id, v_ws, 'comment_resolved', v_entity_type, v_entity_id::text,
           v_scope, v_entity_id::text, 'active', jsonb_build_object('comment_id', p_comment_id)
    FROM public.comments c
    JOIN public.workspace_members wm
      ON wm.workspace_id = v_ws AND wm.user_id = c.author_user_id AND wm.active = true
    WHERE (c.id = p_comment_id OR c.parent_comment_id = p_comment_id)
      AND c.author_user_id <> auth.uid()
      AND ( (v_entity_type = 'post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
         OR (v_entity_type = 'brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  END IF;
  IF (NOT p_resolved) AND v_rows > 0 AND v_seq IS NOT NULL THEN
    INSERT INTO public.inbox_entries
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
    SELECT wm.user_id, v_ws, 'checkpoint_reopened', v_entity_type, v_entity_id::text,
           v_scope, v_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq)
    FROM public.workspace_members wm
    WHERE wm.workspace_id = v_ws AND wm.active = true
      AND wm.role IN ('owner','admin','agency') AND wm.user_id <> auth.uid();
  END IF;
  PERFORM public.audit_log_write('comment_resolve', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text,
          jsonb_build_object('resolved', p_resolved, 'transitioned', v_rows > 0, 'has_note', v_note IS NOT NULL));
END; $$;

CREATE OR REPLACE FUNCTION public.comment_edit(p_comment_id uuid, p_body text, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ledger int; v_words int;
BEGIN
  SELECT workspace_id, ledger_seq INTO v_ws, v_ledger FROM public.comments
   WHERE id = p_comment_id AND author_user_id = auth.uid() AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_body IS NULL OR length(p_body) < 1 OR length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
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
    accepted_at         = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE accepted_at END,
    accepted_by         = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE accepted_by END,
    asked_at            = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE asked_at END,
    asked_by            = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE asked_by END,
    sent_back_at        = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE sent_back_at END,
    sent_back_by        = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE sent_back_by END,
    closed_at           = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE closed_at END,
    closed_by           = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE closed_by END
  WHERE id = p_comment_id;
  PERFORM public.audit_log_write('comment_edit', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text, jsonb_build_object('checkpoint', v_ledger IS NOT NULL));
  RETURN p_comment_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.stage_transition(
  p_post_id uuid, p_to_stage text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ws uuid; v_from text; v_cap text; v_ok boolean; v_closed int := 0;
BEGIN
  SELECT workspace_id, stage INTO v_ws, v_from FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  v_ok := (v_from='draft'    AND p_to_stage IN ('review','parked'))
       OR (v_from='review'   AND p_to_stage IN ('approved','rejected','parked'))
       OR (v_from='approved' AND p_to_stage IN ('parked','rejected'))
       OR (v_from='parked'   AND p_to_stage='review')
       OR (v_from='rejected' AND p_to_stage='review');
  IF NOT v_ok THEN RAISE EXCEPTION 'invalid_stage_transition'; END IF;
  v_cap := CASE WHEN p_to_stage IN ('approved','rejected') THEN 'post.approve' ELSE 'post.edit' END;
  IF NOT public.proc_capability(v_ws, v_cap) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.posts SET stage=p_to_stage, stage_entered_at=now(), row_version=row_version+1 WHERE id=p_post_id;

  IF p_to_stage = 'approved' THEN
    UPDATE public.comments
       SET closed_at = now(), closed_by = auth.uid()
     WHERE entity_type = 'post' AND entity_id = p_post_id
       AND ledger_seq IS NOT NULL AND deleted_at IS NULL
       AND accepted_at IS NULL AND closed_at IS NULL;
    GET DIAGNOSTICS v_closed = ROW_COUNT;
  ELSIF v_from = 'approved' THEN
    UPDATE public.comments
       SET closed_at = NULL, closed_by = NULL
     WHERE entity_type = 'post' AND entity_id = p_post_id
       AND ledger_seq IS NOT NULL AND closed_at IS NOT NULL;
  END IF;

  PERFORM public.audit_log_write('stage_transition','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('from',v_from,'to',p_to_stage,'checkpoints_closed',v_closed));
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage)
  FROM public.workspace_members wm
  WHERE wm.workspace_id=v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  RETURN p_post_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.checkpoint_send_back(uuid,text,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.checkpoint_ask(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkpoint_send_back(uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_ask(uuid,text,uuid) TO authenticated;
