-- Record of schema and proc changes already applied to the live database via MCP.
-- History only; the hosted database already has all of it. This file exists so a
-- fresh local or CI database, built by replaying migrations, reaches the same state.
--
-- Contents:
--   1. comments: checkpoint accept/withdraw columns, accept guard, accept index.
--   2. post_ready_notifications: audit trail of "post ready" notifications.
--   3. inbox_entries_event_type_check: widen to admit 'checkpoint_reopened'.
--   4. checkpoint_accept, comment_delete.
--   5. comment_resolve, comment_edit, comment_create, comment_batch_create,
--      post_ready_notify: replaced to fold in accept state and plain replies.

-- 1. comments: checkpoint accept state ----------------------------------------

ALTER TABLE public.comments
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN unaccepted_at timestamptz,
  ADD COLUMN unaccepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.comments
  ADD CONSTRAINT comments_accept_requires_resolved_checkpoint
  CHECK (accepted_at IS NULL OR (ledger_seq IS NOT NULL AND resolved_at IS NOT NULL));

CREATE INDEX comments_checkpoint_accept_idx
  ON public.comments (entity_id, ledger_seq)
  WHERE ledger_seq IS NOT NULL AND deleted_at IS NULL;

-- 2. post_ready_notifications -------------------------------------------------

CREATE TABLE public.post_ready_notifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  checkpoint_count int NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_ready_notifications_post_sent_idx
  ON public.post_ready_notifications (post_id, sent_at DESC);

ALTER TABLE public.post_ready_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY post_ready_notifications_select_member
  ON public.post_ready_notifications
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.is_active_workspace_member(workspace_id));

REVOKE INSERT, UPDATE, DELETE ON public.post_ready_notifications FROM authenticated;
GRANT SELECT ON public.post_ready_notifications TO authenticated;

-- 3. inbox_entries event type widen -------------------------------------------

ALTER TABLE public.inbox_entries
  DROP CONSTRAINT inbox_entries_event_type_check;

ALTER TABLE public.inbox_entries
  ADD CONSTRAINT inbox_entries_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'comment','mention','stage_change','comment_resolved',
    'brief_created','brief_closed','asset_uploaded','asset_version_added',
    'invite','trial_warning','billing_failure','system',
    'checkpoints_added','post_ready','checkpoint_reopened'
  ]));

-- 4. new functions ------------------------------------------------------------

CREATE FUNCTION public.checkpoint_accept(p_comment_id uuid, p_accepted boolean, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ledger int; v_resolved timestamptz; v_deleted timestamptz; v_rows int := 0;
BEGIN
  SELECT workspace_id, ledger_seq, resolved_at, deleted_at
    INTO v_ws, v_ledger, v_resolved, v_deleted
  FROM public.comments WHERE id = p_comment_id;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF v_ledger IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_accepted THEN
    IF v_resolved IS NULL THEN RAISE EXCEPTION 'invalid_stage'; END IF;
    UPDATE public.comments
       SET accepted_at = now(), accepted_by = auth.uid(),
           unaccepted_at = NULL, unaccepted_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL;
  ELSE
    UPDATE public.comments
       SET accepted_at = NULL, accepted_by = NULL,
           unaccepted_at = now(), unaccepted_by = auth.uid()
     WHERE id = p_comment_id AND deleted_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.audit_log_write('checkpoint_accept', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text,
          jsonb_build_object('accepted', p_accepted, 'transitioned', v_rows > 0));
END; $function$;

REVOKE EXECUTE ON FUNCTION public.checkpoint_accept(uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkpoint_accept(uuid, boolean, uuid) TO authenticated;

CREATE FUNCTION public.comment_delete(p_comment_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ledger int; v_parent uuid; v_rows int := 0;
BEGIN
  SELECT workspace_id, ledger_seq, parent_comment_id INTO v_ws, v_ledger, v_parent
  FROM public.comments
   WHERE id = p_comment_id AND author_user_id = auth.uid() AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_ledger IS NOT NULL OR v_parent IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.comments SET deleted_at = now() WHERE id = p_comment_id AND deleted_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.audit_log_write('comment_delete', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text, jsonb_build_object('transitioned', v_rows > 0));
END; $function$;

REVOKE EXECUTE ON FUNCTION public.comment_delete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_delete(uuid, uuid) TO authenticated;

-- 5. replaced functions -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.comment_resolve(p_comment_id uuid, p_resolved boolean, p_trace_id uuid, p_resolution_note text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_entity_type text; v_entity_id uuid; v_parent uuid;
        v_deleted timestamptz; v_scope text; v_is_draft boolean := false;
        v_brief_owner uuid; v_rows int := 0; v_note text; v_version_id uuid; v_ledger int;
BEGIN
  IF p_resolution_note IS NOT NULL AND char_length(p_resolution_note) > 500 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  v_note := nullif(btrim(coalesce(p_resolution_note, '')), '');
  SELECT workspace_id, entity_type, entity_id, parent_comment_id, deleted_at, ledger_seq
    INTO v_ws, v_entity_type, v_entity_id, v_parent, v_deleted, v_ledger
  FROM public.comments WHERE id = p_comment_id;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_parent IS NOT NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_resolved THEN
    IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid()
                     AND wm.active = true AND wm.role IN ('owner','admin','agency')) THEN
      RAISE EXCEPTION 'forbidden_role';
    END IF;
    IF v_entity_type = 'post' THEN
      SELECT id INTO v_version_id FROM public.post_versions
       WHERE post_id = v_entity_id ORDER BY version_number DESC LIMIT 1;
    END IF;
    UPDATE public.comments
       SET resolved_at = now(), resolved_by = auth.uid(), resolution_note = v_note,
           resolved_version_id = v_version_id
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NULL;
  ELSE
    UPDATE public.comments
       SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL,
           resolved_version_id = NULL, accepted_at = NULL, accepted_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF p_resolved AND v_rows > 0 THEN
    IF v_entity_type = 'post' THEN
      v_scope := 'posts';
      SELECT (stage = 'draft') INTO v_is_draft FROM public.posts WHERE id = v_entity_id;
      v_is_draft := coalesce(v_is_draft, false);
    ELSE
      v_scope := 'briefs';
      SELECT created_by INTO v_brief_owner FROM public.briefs WHERE id = v_entity_id;
    END IF;
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
  IF NOT p_resolved AND v_rows > 0 AND v_ledger IS NOT NULL THEN
    INSERT INTO public.inbox_entries
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
    SELECT wm.user_id, v_ws, 'checkpoint_reopened', v_entity_type, v_entity_id::text,
           'posts', v_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', p_comment_id, 'seq', v_ledger)
    FROM public.workspace_members wm
    WHERE wm.workspace_id = v_ws AND wm.active = true
      AND wm.role IN ('owner','admin','agency') AND wm.user_id <> auth.uid();
  END IF;
  PERFORM public.audit_log_write('comment_resolve', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text,
          jsonb_build_object('resolved', p_resolved, 'transitioned', v_rows > 0, 'has_note', v_note IS NOT NULL));
END; $function$;

REVOKE EXECUTE ON FUNCTION public.comment_resolve(uuid, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_resolve(uuid, boolean, uuid, text) TO authenticated;

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
    accepted_by         = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE accepted_by END
  WHERE id = p_comment_id;
  PERFORM public.audit_log_write('comment_edit', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text, jsonb_build_object('checkpoint', v_ledger IS NOT NULL));
  RETURN p_comment_id;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.comment_edit(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_edit(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.comment_create(p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid, p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_scope text; v_is_draft boolean := false; v_brief_owner uuid; v_mentioned uuid[];
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_entity_type = 'post' AND p_parent_comment_id IS NULL AND EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
         AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF p_entity_type NOT IN ('post','brief') OR p_entity_id IS NULL
     OR p_body IS NULL OR char_length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF char_length(btrim(p_body)) = 0
     AND coalesce(array_length(p_attachment_asset_ids,1),0) = 0 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_parent_comment_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.comments WHERE id=p_parent_comment_id AND parent_comment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    INSERT INTO public.comments (workspace_id, entity_type, entity_id, parent_comment_id, author_user_id,
      body, mentions, attachment_asset_ids)
    VALUES (p_workspace_id, p_entity_type, p_entity_id, p_parent_comment_id, auth.uid(),
      p_body, p_mentions, p_attachment_asset_ids) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF p_attachment_asset_ids IS NOT NULL AND array_length(p_attachment_asset_ids,1) IS NOT NULL THEN
    IF (SELECT count(*) FROM public.asset_versions av
          JOIN public.assets a ON a.id = av.asset_id
         WHERE av.id = ANY(p_attachment_asset_ids) AND av.workspace_id = p_workspace_id
           AND a.deleted_at IS NULL)
       <> array_length(p_attachment_asset_ids,1) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    INSERT INTO public.asset_attachments
      (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
    SELECT av.asset_id, av.id, 'comment', v_id::text, p_workspace_id, (u.ord-1)::int, auth.uid()
    FROM unnest(p_attachment_asset_ids) WITH ORDINALITY AS u(version_id, ord)
    JOIN public.asset_versions av ON av.id = u.version_id;
  END IF;
  IF p_mentions IS NOT NULL AND jsonb_typeof(p_mentions)='array' THEN
    SELECT array_agg(val::uuid) INTO v_mentioned FROM jsonb_array_elements_text(p_mentions) AS val;
  END IF;
  v_mentioned := coalesce(v_mentioned, ARRAY[]::uuid[]);
  IF p_entity_type='post' THEN
    v_scope := 'posts';
    SELECT (stage='draft') INTO v_is_draft FROM public.posts WHERE id=p_entity_id;
    v_is_draft := coalesce(v_is_draft,false);
  ELSE
    v_scope := 'briefs';
    SELECT created_by INTO v_brief_owner FROM public.briefs WHERE id=p_entity_id;
  END IF;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, p_workspace_id, 'comment', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'active',
         jsonb_build_object('comment_id', v_id)
  FROM public.workspace_members wm
  WHERE wm.workspace_id=p_workspace_id AND wm.active = true
    AND wm.user_id <> auth.uid() AND wm.user_id <> ALL(v_mentioned)
    AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
       OR (p_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  IF array_length(v_mentioned,1) IS NOT NULL THEN
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
    SELECT wm.user_id, p_workspace_id, 'mention', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', v_id)
    FROM public.workspace_members wm
    WHERE wm.workspace_id=p_workspace_id AND wm.active = true
      AND wm.user_id = ANY(v_mentioned) AND wm.user_id <> auth.uid()
      AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
         OR (p_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  END IF;
  PERFORM public.audit_log_write('comment_create','success',p_trace_id,p_workspace_id,'comment',v_id::text,
          jsonb_build_object('entity_type',p_entity_type));
  RETURN v_id;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.comment_create(uuid, text, uuid, uuid, text, jsonb, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_create(uuid, text, uuid, uuid, text, jsonb, uuid[], uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.comment_batch_create(p_workspace_id uuid, p_post_id uuid, p_points jsonb, p_trace_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_batch uuid := uuidv7(); v_seq int; v_id uuid; v_body text; v_atts uuid[];
  v_point jsonb; v_out jsonb := '[]'::jsonb; v_n int; v_seqs int[] := '{}';
  v_stage text; v_words int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  v_n := CASE WHEN jsonb_typeof(p_points) = 'array' THEN jsonb_array_length(p_points) ELSE 0 END;
  IF v_n < 1 OR v_n > 20 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT stage INTO v_stage FROM public.posts
   WHERE id = p_post_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_stage = 'draft' THEN RAISE EXCEPTION 'invalid_stage'; END IF;
  SELECT coalesce(max(ledger_seq), 0) INTO v_seq FROM public.comments
   WHERE entity_type = 'post' AND entity_id = p_post_id AND ledger_seq IS NOT NULL;
  FOR v_point IN SELECT * FROM jsonb_array_elements(p_points) LOOP
    v_body := btrim(coalesce(v_point->>'body', ''));
    v_words := coalesce(array_length(regexp_split_to_array(v_body, '\s+'), 1), 0);
    IF v_words < 1 OR v_words > 50 OR length(v_body) > 10000 THEN
      RAISE EXCEPTION 'invalid_payload';
    END IF;
    v_atts := NULL;
    IF v_point ? 'attachment_version_ids'
       AND jsonb_typeof(v_point->'attachment_version_ids') = 'array' THEN
      SELECT array_agg(x::uuid) INTO v_atts
      FROM jsonb_array_elements_text(v_point->'attachment_version_ids') x;
    END IF;
    v_seq := v_seq + 1;
    BEGIN
      INSERT INTO public.comments (workspace_id, entity_type, entity_id, parent_comment_id,
        author_user_id, body, mentions, attachment_asset_ids, ledger_seq, ledger_batch_id)
      VALUES (p_workspace_id, 'post', p_post_id, NULL,
        auth.uid(), v_body, NULL, v_atts, v_seq, v_batch)
      RETURNING id INTO v_id;
    EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation OR unique_violation THEN
      RAISE EXCEPTION 'invalid_payload';
    END;
    IF v_atts IS NOT NULL AND array_length(v_atts, 1) IS NOT NULL THEN
      IF (SELECT count(*) FROM public.asset_versions av
            JOIN public.assets a ON a.id = av.asset_id
           WHERE av.id = ANY(v_atts) AND av.workspace_id = p_workspace_id
             AND a.deleted_at IS NULL) <> array_length(v_atts, 1) THEN
        RAISE EXCEPTION 'invalid_payload';
      END IF;
      INSERT INTO public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      SELECT av.asset_id, av.id, 'comment', v_id::text, p_workspace_id, (u.ord - 1)::int, auth.uid()
      FROM unnest(v_atts) WITH ORDINALITY AS u(version_id, ord)
      JOIN public.asset_versions av ON av.id = u.version_id;
    END IF;
    v_seqs := v_seqs || v_seq;
    v_out := v_out || jsonb_build_object('id', v_id, 'seq', v_seq);
  END LOOP;
  INSERT INTO public.inbox_entries
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, p_workspace_id, 'checkpoints_added', 'post', p_post_id::text,
         'posts', p_post_id::text, 'active',
         jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs))
  FROM public.workspace_members wm
  WHERE wm.workspace_id = p_workspace_id AND wm.active = true AND wm.user_id <> auth.uid();
  PERFORM public.audit_log_write('comment_batch_create', 'success', p_trace_id, p_workspace_id,
          'post', p_post_id::text,
          jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs)));
  RETURN v_out;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.comment_batch_create(uuid, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_batch_create(uuid, uuid, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_ready_notify(p_post_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
  IF v_open > 0 THEN RAISE EXCEPTION 'checkpoints_open'; END IF;
  INSERT INTO public.post_ready_notifications (workspace_id, post_id, sent_by, checkpoint_count)
  VALUES (v_ws, p_post_id, auth.uid(), v_total);
  INSERT INTO public.inbox_entries
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'post_ready', 'post', p_post_id::text, 'posts', p_post_id::text,
         'urgent', jsonb_build_object('checkpoints', v_total)
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.role = 'client'
    AND wm.user_id <> auth.uid();
  PERFORM public.audit_log_write('post_ready_notify', 'success', p_trace_id, v_ws, 'post',
          p_post_id::text, jsonb_build_object('checkpoints', v_total));
END; $function$;

REVOKE EXECUTE ON FUNCTION public.post_ready_notify(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_ready_notify(uuid, uuid) TO authenticated;
