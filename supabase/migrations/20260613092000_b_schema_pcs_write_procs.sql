-- B-schema: PCS write procs. Applied via Supabase MCP 2026-06-13 to movnexawfhsyuluspxoc.
-- New SECURITY DEFINER procs: post metadata edit, caption edit (versioned),
-- comment edit / soft-delete, gallery set (versioned). No table or column changes.
CREATE OR REPLACE FUNCTION public._post_snapshot(p_post_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'caption', (SELECT caption FROM public.posts WHERE id = p_post_id),
    'gallery', COALESCE((SELECT jsonb_agg(asset_version_id ORDER BY position)
                         FROM public.asset_attachments
                         WHERE entity_type='post' AND entity_id = p_post_id::text
                           AND deleted_at IS NULL), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public._post_snapshot(uuid) FROM public, authenticated;

CREATE OR REPLACE FUNCTION public.post_update(p_post_id uuid, p_payload jsonb, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_payload ? 'bucket_id' AND NOT EXISTS (
      SELECT 1 FROM public.workspace_buckets b
      WHERE b.id=(p_payload->>'bucket_id')::uuid AND b.workspace_id=v_ws) THEN
    RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    UPDATE public.posts SET
      title         = CASE WHEN p_payload ? 'title'         THEN p_payload->>'title' ELSE title END,
      bucket_id     = CASE WHEN p_payload ? 'bucket_id'     THEN (p_payload->>'bucket_id')::uuid ELSE bucket_id END,
      owner_user_id = CASE WHEN p_payload ? 'owner_user_id' THEN NULLIF(p_payload->>'owner_user_id','')::uuid ELSE owner_user_id END,
      target_date   = CASE WHEN p_payload ? 'target_date'   THEN NULLIF(p_payload->>'target_date','')::timestamptz ELSE target_date END,
      row_version   = row_version + 1, updated_at = now()
    WHERE id=p_post_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  PERFORM public.audit_log_write('post_update','success',p_trace_id,v_ws,'post',p_post_id::text,'{}'::jsonb);
  RETURN p_post_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.post_update(uuid,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_caption_update(p_post_id uuid, p_caption text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid; v_ver uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_caption IS NULL OR length(p_caption) < 1 OR length(p_caption) > 5000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.posts SET caption=p_caption, row_version=row_version+1, updated_at=now() WHERE id=p_post_id;
  v_ver := public.post_version_create(p_post_id, public._post_snapshot(p_post_id), p_trace_id);
  PERFORM public.audit_log_write('post_caption_update','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('version_id',v_ver));
  RETURN v_ver;
END; $$;
GRANT EXECUTE ON FUNCTION public.post_caption_update(uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.comment_edit(p_comment_id uuid, p_body text, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.comments
   WHERE id=p_comment_id AND author_user_id=auth.uid() AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_body IS NULL OR length(p_body) < 1 OR length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.comments SET body=p_body, edited_at=now() WHERE id=p_comment_id;
  PERFORM public.audit_log_write('comment_edit','success',p_trace_id,v_ws,'comment',p_comment_id::text,'{}'::jsonb);
  RETURN p_comment_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.comment_edit(uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.comment_soft_delete(p_comment_id uuid, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.comments
   WHERE id=p_comment_id AND author_user_id=auth.uid() AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.comments SET deleted_at=now() WHERE id=p_comment_id;
  PERFORM public.audit_log_write('comment_soft_delete','success',p_trace_id,v_ws,'comment',p_comment_id::text,'{}'::jsonb);
  RETURN p_comment_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.comment_soft_delete(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.gallery_set(p_post_id uuid, p_asset_version_ids uuid[], p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws uuid; v_ver uuid; v_uid uuid := auth.uid(); i int;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_asset_version_ids IS NULL OR array_length(p_asset_version_ids,1) IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_asset_version_ids) av(id)
             LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=v_ws
             WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.asset_attachments SET deleted_at=now()
   WHERE entity_type='post' AND entity_id=p_post_id::text AND deleted_at IS NULL
     AND asset_version_id <> ALL(p_asset_version_ids);
  FOR i IN 1..array_length(p_asset_version_ids,1) LOOP
    UPDATE public.asset_attachments SET position=i-1, deleted_at=NULL
     WHERE entity_type='post' AND entity_id=p_post_id::text AND asset_version_id=p_asset_version_ids[i];
    IF NOT FOUND THEN
      INSERT INTO public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      SELECT v.asset_id, v.id, 'post', p_post_id::text, v_ws, i-1, v_uid
        FROM public.asset_versions v WHERE v.id=p_asset_version_ids[i];
    END IF;
  END LOOP;
  UPDATE public.posts SET row_version=row_version+1, updated_at=now() WHERE id=p_post_id;
  v_ver := public.post_version_create(p_post_id, public._post_snapshot(p_post_id), p_trace_id);
  PERFORM public.audit_log_write('gallery_set','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('count',array_length(p_asset_version_ids,1),'version_id',v_ver));
  RETURN v_ver;
END; $$;
GRANT EXECUTE ON FUNCTION public.gallery_set(uuid,uuid[],uuid) TO authenticated;
