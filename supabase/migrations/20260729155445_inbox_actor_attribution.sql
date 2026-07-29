-- Inbox actor attribution: record WHO performed the event on each inbox entry,
-- distinct from user_id (the recipient). Already applied to the live database
-- via MCP. Written idempotently so a replay against live is a no-op and a fresh
-- container built from migration history produces the same objects.
--
-- 1. inbox_entries gains actor_user_id (nullable, FK users, ON DELETE SET NULL),
--    on the partitioned parent so it propagates to every partition.
-- 2. Two guarded backfills populate it from comments.author_user_id.
-- 3. inbox_entry_create gains an eleventh param p_actor_user_id.
-- 4. Seven procs that fan out into inbox_entries now stamp actor_user_id.

ALTER TABLE public.inbox_entries
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- Backfill (a): entries whose payload names a single comment. Guarded so a
-- replay only touches rows still missing the actor.
UPDATE public.inbox_entries e
   SET actor_user_id = c.author_user_id
  FROM public.comments c
 WHERE e.actor_user_id IS NULL
   AND e.payload ? 'comment_id'
   AND c.id = (e.payload->>'comment_id')::uuid;

-- Backfill (b): batch fan-out entries. The actor is the author of the
-- lowest-ledger_seq comment in the batch.
UPDATE public.inbox_entries e
   SET actor_user_id = c.author_user_id
  FROM public.comments c
 WHERE e.actor_user_id IS NULL
   AND e.payload ? 'batch_id'
   AND c.id = (
     SELECT c2.id FROM public.comments c2
      WHERE c2.ledger_batch_id = (e.payload->>'batch_id')::uuid
      ORDER BY c2.ledger_seq ASC
      LIMIT 1);

-- ---------------------------------------------------------------------------
-- inbox_entry_create: eleventh parameter p_actor_user_id, stamped into the
-- INSERT. Dropped and recreated because the signature changes. Not granted to
-- authenticated (server / service-role callers only).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.inbox_entry_create(uuid,uuid,text,text,text,text,text,text,jsonb,uuid);
CREATE FUNCTION public.inbox_entry_create(
  p_user_id uuid,
  p_workspace_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_scope text,
  p_scope_key text,
  p_tier text,
  p_payload jsonb,
  p_trace_id uuid,
  p_actor_user_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF p_user_id IS NULL OR p_event_type IS NULL OR p_scope IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  BEGIN
    INSERT INTO public.inbox_entries (
      user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    VALUES (
      p_user_id, p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_scope, p_scope_key,
      coalesce(p_tier, 'active'), coalesce(p_payload, '{}'::jsonb), p_actor_user_id)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'inbox_entry_create', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => p_workspace_id, p_entity_type => 'inbox_entry', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('event_type', p_event_type));
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.inbox_entry_create(uuid,uuid,text,text,text,text,text,text,jsonb,uuid,uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Seven procs that INSERT into inbox_entries directly: each fan-out now stamps
-- actor_user_id = auth.uid(). Bodies copied verbatim from their most recent
-- migration definitions; the ONLY change is the appended column and expression.
-- ---------------------------------------------------------------------------

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
    entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'checkpoint_reopened', 'post', v_entity_id::text,
         'posts', v_entity_id::text, 'urgent',
         jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq, 'reply_id', v_reply),
         auth.uid()
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
    entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'checkpoint_asked', 'post', v_entity_id::text,
         'posts', v_entity_id::text, 'urgent',
         jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq, 'reply_id', v_reply),
         auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true
    AND wm.role = 'client' AND wm.user_id <> auth.uid();

  PERFORM public.audit_log_write('checkpoint_ask','success',p_trace_id,v_ws,
    'comment', p_comment_id::text, jsonb_build_object('seq',v_seq,'reply_id',v_reply));
  RETURN v_reply;
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
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    SELECT DISTINCT wm.user_id, v_ws, 'comment_resolved', v_entity_type, v_entity_id::text,
           v_scope, v_entity_id::text, 'active', jsonb_build_object('comment_id', p_comment_id),
           auth.uid()
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
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    SELECT wm.user_id, v_ws, 'checkpoint_reopened', v_entity_type, v_entity_id::text,
           v_scope, v_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq),
           auth.uid()
    FROM public.workspace_members wm
    WHERE wm.workspace_id = v_ws AND wm.active = true
      AND wm.role IN ('owner','admin','agency') AND wm.user_id <> auth.uid();
  END IF;
  PERFORM public.audit_log_write('comment_resolve', 'success', p_trace_id, v_ws, 'comment',
          p_comment_id::text,
          jsonb_build_object('resolved', p_resolved, 'transitioned', v_rows > 0, 'has_note', v_note IS NOT NULL));
END; $$;

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
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage),
         auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id=v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  RETURN p_post_id;
END; $$;

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
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, p_workspace_id, 'comment', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'active',
         jsonb_build_object('comment_id', v_id),
         auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id=p_workspace_id AND wm.active = true
    AND wm.user_id <> auth.uid() AND wm.user_id <> ALL(v_mentioned)
    AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
       OR (p_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  IF array_length(v_mentioned,1) IS NOT NULL THEN
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    SELECT wm.user_id, p_workspace_id, 'mention', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', v_id),
           auth.uid()
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
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, p_workspace_id, 'checkpoints_added', 'post', p_post_id::text,
         'posts', p_post_id::text, 'active',
         jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs)),
         auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id = p_workspace_id AND wm.active = true AND wm.user_id <> auth.uid();
  PERFORM public.audit_log_write('comment_batch_create', 'success', p_trace_id, p_workspace_id,
          'post', p_post_id::text,
          jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs)));
  RETURN v_out;
END; $function$;

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
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'post_ready', 'post', p_post_id::text, 'posts', p_post_id::text,
         'urgent', jsonb_build_object('checkpoints', v_total),
         auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.role = 'client'
    AND wm.user_id <> auth.uid();
  PERFORM public.audit_log_write('post_ready_notify', 'success', p_trace_id, v_ws, 'post',
          p_post_id::text, jsonb_build_object('checkpoints', v_total));
END; $function$;
