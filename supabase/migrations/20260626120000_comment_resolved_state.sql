-- Comment resolved state: replace the per-comment decision flag with a
-- thread-level resolved state. Drops comments.is_decision (and its index), adds
-- resolved_at / resolved_by on the root comment, swaps the dead 'decision_marked'
-- inbox event for 'comment_resolved', and adds the comment_resolve toggle proc.
-- comment_create loses its p_is_decision argument in the same pass.

-- 1. comment_create: drop is_decision (recreate first, before column is gone)
DROP FUNCTION public.comment_create(uuid,text,uuid,uuid,text,jsonb,uuid[],boolean,uuid);

CREATE FUNCTION public.comment_create(
  p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid,
  p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid; v_scope text; v_is_draft boolean := false; v_brief_owner uuid; v_mentioned uuid[];
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
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
END; $$;

REVOKE EXECUTE ON FUNCTION public.comment_create(uuid,text,uuid,uuid,text,jsonb,uuid[],uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.comment_create(uuid,text,uuid,uuid,text,jsonb,uuid[],uuid) TO authenticated;

-- 2. drop the decision flag (DESTRUCTIVE; rollback: ADD COLUMN is_decision boolean NOT NULL DEFAULT false)
DROP INDEX public.comments_decision_idx;
ALTER TABLE public.comments DROP COLUMN is_decision;

-- 3. add resolved state (resolved_by is a *_by column -> ON DELETE SET NULL)
ALTER TABLE public.comments
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- 4. inbox enum: drop dead decision_marked, add comment_resolved (0 rows, safe)
ALTER TABLE public.inbox_entries DROP CONSTRAINT inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK (event_type = ANY (ARRAY['comment','mention','stage_change','comment_resolved',
    'brief_created','brief_closed','asset_uploaded','asset_version_added',
    'invite','trial_warning','billing_failure','system']));

-- 5. comment_resolve: toggle resolve/reopen on a root thread
CREATE FUNCTION public.comment_resolve(p_comment_id uuid, p_resolved boolean, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_ws uuid; v_entity_type text; v_entity_id uuid; v_parent uuid;
        v_deleted timestamptz; v_scope text; v_is_draft boolean := false; v_brief_owner uuid; v_rows int := 0;
BEGIN
  SELECT workspace_id, entity_type, entity_id, parent_comment_id, deleted_at
    INTO v_ws, v_entity_type, v_entity_id, v_parent, v_deleted
  FROM public.comments WHERE id = p_comment_id;
  IF v_ws IS NULL OR v_deleted IS NOT NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_parent IS NOT NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;  -- thread-level: root only

  IF p_resolved THEN
    UPDATE public.comments SET resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NULL;
  ELSE
    UPDATE public.comments SET resolved_at = NULL, resolved_by = NULL
     WHERE id = p_comment_id AND deleted_at IS NULL AND resolved_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF p_resolved AND v_rows > 0 THEN  -- notify only on a real open->resolved transition; reopen is silent
    IF v_entity_type='post' THEN
      v_scope := 'posts';
      SELECT (stage='draft') INTO v_is_draft FROM public.posts WHERE id=v_entity_id;
      v_is_draft := coalesce(v_is_draft,false);
    ELSE
      v_scope := 'briefs';
      SELECT created_by INTO v_brief_owner FROM public.briefs WHERE id=v_entity_id;
    END IF;
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
    SELECT DISTINCT wm.user_id, v_ws, 'comment_resolved', v_entity_type, v_entity_id::text, v_scope, v_entity_id::text, 'active',
           jsonb_build_object('comment_id', p_comment_id)
    FROM public.comments c
    JOIN public.workspace_members wm
      ON wm.workspace_id = v_ws AND wm.user_id = c.author_user_id AND wm.active = true
    WHERE (c.id = p_comment_id OR c.parent_comment_id = p_comment_id)
      AND c.author_user_id <> auth.uid()
      AND ( (v_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
         OR (v_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  END IF;

  PERFORM public.audit_log_write('comment_resolve','success',p_trace_id,v_ws,'comment',p_comment_id::text,
          jsonb_build_object('resolved',p_resolved,'transitioned',v_rows > 0));
END; $$;

REVOKE EXECUTE ON FUNCTION public.comment_resolve(uuid,boolean,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.comment_resolve(uuid,boolean,uuid) TO authenticated;
