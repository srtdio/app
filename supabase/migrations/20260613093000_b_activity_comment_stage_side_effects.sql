-- B-activity: comment + stage side-effects. Applied via Supabase MCP 2026-06-13 to movnexawfhsyuluspxoc.
-- comment_create: one-level threading guard, comment attachments land in Assets, comment/mention Activity events.
-- stage_transition: stage_change Activity event. Signatures unchanged; grants preserved by REPLACE.
CREATE OR REPLACE FUNCTION public.comment_create(
  p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid,
  p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_is_decision boolean, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_scope text; v_is_draft boolean := false; v_brief_owner uuid; v_mentioned uuid[];
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_entity_type NOT IN ('post','brief') OR p_entity_id IS NULL OR p_body IS NULL
     OR length(p_body) < 1 OR length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_parent_comment_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.comments WHERE id=p_parent_comment_id AND parent_comment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    INSERT INTO public.comments (workspace_id, entity_type, entity_id, parent_comment_id, author_user_id,
      body, mentions, attachment_asset_ids, is_decision)
    VALUES (p_workspace_id, p_entity_type, p_entity_id, p_parent_comment_id, auth.uid(),
      p_body, p_mentions, p_attachment_asset_ids, coalesce(p_is_decision,false)) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF p_attachment_asset_ids IS NOT NULL AND array_length(p_attachment_asset_ids,1) IS NOT NULL THEN
    IF (SELECT count(*) FROM public.assets a
         WHERE a.id = ANY(p_attachment_asset_ids) AND a.workspace_id=p_workspace_id
           AND a.current_version_id IS NOT NULL AND a.deleted_at IS NULL)
       <> array_length(p_attachment_asset_ids,1) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    INSERT INTO public.asset_attachments
      (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
    SELECT a.id, a.current_version_id, 'comment', v_id::text, p_workspace_id, (u.ord-1)::int, auth.uid()
    FROM unnest(p_attachment_asset_ids) WITH ORDINALITY AS u(asset_id, ord)
    JOIN public.assets a ON a.id = u.asset_id;
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
          jsonb_build_object('entity_type',p_entity_type,'is_decision',coalesce(p_is_decision,false)));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid; v_from text; v_cap text; v_ok boolean;
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
  UPDATE public.posts SET stage=p_to_stage, row_version=row_version+1 WHERE id=p_post_id;
  PERFORM public.audit_log_write('stage_transition','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('from',v_from,'to',p_to_stage));
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
  SELECT wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage)
  FROM public.workspace_members wm
  WHERE wm.workspace_id=v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  RETURN p_post_id;
END; $$;
