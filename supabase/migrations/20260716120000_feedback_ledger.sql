-- Applied via MCP 2026-07-16. History only. Do not re-run.

ALTER TABLE public.comments
  ADD COLUMN ledger_seq integer,
  ADD COLUMN ledger_batch_id uuid,
  ADD COLUMN resolution_note text;

ALTER TABLE public.comments ADD CONSTRAINT comments_ledger_shape_check
CHECK (ledger_seq IS NULL OR (ledger_seq > 0 AND parent_comment_id IS NULL AND entity_type = 'post'));

ALTER TABLE public.comments ADD CONSTRAINT comments_ledger_word_cap_check
CHECK (ledger_seq IS NULL OR array_length(regexp_split_to_array(btrim(body), '\s+'), 1) BETWEEN 1 AND 50);

ALTER TABLE public.comments ADD CONSTRAINT comments_resolution_note_len_check
CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX comments_entity_ledger_seq_key
ON public.comments (entity_id, ledger_seq) WHERE ledger_seq IS NOT NULL;

CREATE INDEX comments_open_checkpoints_idx
ON public.comments (entity_id)
WHERE ledger_seq IS NOT NULL AND resolved_at IS NULL AND deleted_at IS NULL;

CREATE FUNCTION public.comment_batch_create(
  p_workspace_id uuid, p_post_id uuid, p_points jsonb, p_trace_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
END; $$;

REVOKE EXECUTE ON FUNCTION public.comment_batch_create(uuid, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_batch_create(uuid, uuid, jsonb, uuid) TO authenticated;

DROP FUNCTION public.comment_resolve(uuid, boolean, uuid);

CREATE FUNCTION public.comment_resolve(
  p_comment_id uuid, p_resolved boolean, p_trace_id uuid, p_resolution_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_ws uuid; v_entity_type text; v_entity_id uuid; v_parent uuid;
        v_deleted timestamptz; v_scope text; v_is_draft boolean := false;
        v_brief_owner uuid; v_rows int := 0; v_note text;
BEGIN
  IF p_resolution_note IS NOT NULL AND char_length(p_resolution_note) > 500 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  v_note := nullif(btrim(coalesce(p_resolution_note, '')), '');
  SELECT workspace_id, entity_type, entity_id, parent_comment_id, deleted_at
    INTO v_ws, v_entity_type, v_entity_id, v_parent, v_deleted
  FROM public.comments WHERE id = p_comment_id;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_parent IS NOT NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_resolved THEN
    UPDATE public.comments
       SET resolved_at = now(), resolved_by = auth.uid(), resolution_note = v_note
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NULL;
  ELSE
    UPDATE public.comments
       SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
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
  PERFORM public.audit_log_write('comment_resolve', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text,
          jsonb_build_object('resolved', p_resolved, 'transitioned', v_rows > 0, 'has_note', v_note IS NOT NULL));
END; $$;

REVOKE EXECUTE ON FUNCTION public.comment_resolve(uuid, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comment_resolve(uuid, boolean, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.comment_edit(p_comment_id uuid, p_body text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
    resolved_at    = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolved_at END,
    resolved_by    = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolved_by END,
    resolution_note = CASE WHEN v_ledger IS NOT NULL THEN NULL ELSE resolution_note END
  WHERE id = p_comment_id;
  PERFORM public.audit_log_write('comment_edit', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text, jsonb_build_object('checkpoint', v_ledger IS NOT NULL));
  RETURN p_comment_id;
END; $$;

CREATE FUNCTION public.post_ready_notify(p_post_id uuid, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
  INSERT INTO public.inbox_entries
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'post_ready', 'post', p_post_id::text, 'posts', p_post_id::text,
         'urgent', jsonb_build_object('checkpoints', v_total)
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.role = 'client'
    AND wm.user_id <> auth.uid();
  PERFORM public.audit_log_write('post_ready_notify', 'success', p_trace_id, v_ws, 'post',
          p_post_id::text, jsonb_build_object('checkpoints', v_total));
END; $$;

REVOKE EXECUTE ON FUNCTION public.post_ready_notify(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_ready_notify(uuid, uuid) TO authenticated;
