-- Post flow B: approved-post lock.
-- On a post with stage='approved', title, caption, pictures and owner cannot
-- change; target_date and bucket stay editable. Each proc below is rebuilt from
-- its LIVE body (pg_get_functiondef) with one addition: a guard right after the
-- existing proc_capability check raising 'post_approved_locked'.
-- post_version_create is guarded too: no proc or trigger calls it during a stage
-- change (stage_transition never versions), only post_caption_update and
-- gallery_set, which are themselves guarded first.
-- Signatures and return types are unchanged; CREATE OR REPLACE keeps grants.

CREATE OR REPLACE FUNCTION public.post_caption_update(p_post_id uuid, p_caption text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ver uuid; v_old text;
BEGIN
  SELECT workspace_id, caption INTO v_ws, v_old FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id AND stage = 'approved') THEN RAISE EXCEPTION 'post_approved_locked'; END IF;
  IF p_caption IS NULL OR length(p_caption) < 1 OR length(p_caption) > 5000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF v_old IS NOT DISTINCT FROM p_caption THEN
    SELECT id INTO v_ver FROM public.post_versions WHERE post_id=p_post_id ORDER BY version_number DESC LIMIT 1;
    IF v_ver IS NOT NULL THEN RETURN v_ver; END IF;
  END IF;
  UPDATE public.posts SET caption=p_caption, row_version=row_version+1, updated_at=now() WHERE id=p_post_id;
  v_ver := public.post_version_create(p_post_id, public._post_snapshot(p_post_id), p_trace_id);
  PERFORM public.audit_log_write('post_caption_update','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('version_id',v_ver));
  RETURN v_ver;
END; $function$;

CREATE OR REPLACE FUNCTION public.post_update(p_post_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF (p_payload ? 'title' OR p_payload ? 'owner_user_id')
     AND EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id AND stage = 'approved') THEN
    RAISE EXCEPTION 'post_approved_locked'; END IF;
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
END; $function$;

CREATE OR REPLACE FUNCTION public.gallery_set(p_post_id uuid, p_asset_version_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ver uuid; v_uid uuid := auth.uid(); i int; v_len int;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id AND stage = 'approved') THEN RAISE EXCEPTION 'post_approved_locked'; END IF;
  IF p_asset_version_ids IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_len := COALESCE(array_length(p_asset_version_ids,1),0);
  IF EXISTS (SELECT 1 FROM unnest(p_asset_version_ids) av(id)
             LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=v_ws
             WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
             WHERE v.id = ANY(p_asset_version_ids) AND v.workspace_id = v_ws
               AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM public.asset_attachments x
                               WHERE x.entity_type='post' AND x.entity_id=p_post_id::text
                                 AND x.deleted_at IS NULL AND x.asset_version_id = v.id)) THEN
    RAISE EXCEPTION 'attachment not available'; END IF;
  IF COALESCE((SELECT array_agg(asset_version_id ORDER BY position) FROM public.asset_attachments
      WHERE entity_type='post' AND entity_id=p_post_id::text AND deleted_at IS NULL), '{}'::uuid[])
     IS NOT DISTINCT FROM p_asset_version_ids THEN
    SELECT id INTO v_ver FROM public.post_versions WHERE post_id=p_post_id ORDER BY version_number DESC LIMIT 1;
    IF v_ver IS NOT NULL THEN RETURN v_ver; END IF;
  END IF;
  UPDATE public.asset_attachments SET deleted_at=now()
   WHERE entity_type='post' AND entity_id=p_post_id::text AND deleted_at IS NULL
     AND asset_version_id <> ALL(p_asset_version_ids);
  IF v_len > 0 THEN
    FOR i IN 1..v_len LOOP
      UPDATE public.asset_attachments SET position=i-1, deleted_at=NULL
       WHERE entity_type='post' AND entity_id=p_post_id::text AND asset_version_id=p_asset_version_ids[i];
      IF NOT FOUND THEN
        INSERT INTO public.asset_attachments
          (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
        SELECT v.asset_id, v.id, 'post', p_post_id::text, v_ws, i-1, v_uid
          FROM public.asset_versions v WHERE v.id=p_asset_version_ids[i];
      END IF;
    END LOOP;
  END IF;
  UPDATE public.posts SET row_version=row_version+1, updated_at=now() WHERE id=p_post_id;
  v_ver := public.post_version_create(p_post_id, public._post_snapshot(p_post_id), p_trace_id);
  PERFORM public.audit_log_write('gallery_set','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('count',v_len,'version_id',v_ver));
  RETURN v_ver;
END; $function$;

CREATE OR REPLACE FUNCTION public.post_version_create(p_post_id uuid, p_snapshot jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c_window constant interval := interval '15 minutes';
  v_ws uuid; v_stage_entered timestamptz; v_last record; v_n integer; v_id uuid;
BEGIN
  SELECT workspace_id, stage_entered_at INTO v_ws, v_stage_entered
  FROM public.posts WHERE id = p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id AND stage = 'approved') THEN RAISE EXCEPTION 'post_approved_locked'; END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  SELECT id, created_by, created_at, last_edited_at, version_number, snapshot
  INTO v_last
  FROM public.post_versions
  WHERE post_id = p_post_id
  ORDER BY version_number DESC
  LIMIT 1;

  IF v_last.id IS NOT NULL AND v_last.snapshot = p_snapshot THEN
    RETURN v_last.id;
  END IF;

  IF v_last.id IS NOT NULL
     AND v_last.created_by IS NOT NULL
     AND v_last.created_by = auth.uid()
     AND now() - coalesce(v_last.last_edited_at, v_last.created_at) < c_window
     AND v_stage_entered IS NOT NULL
     AND v_stage_entered <= v_last.created_at
     AND NOT EXISTS (SELECT 1 FROM public.post_annotations a WHERE a.post_version_id = v_last.id)
  THEN
    UPDATE public.post_versions
    SET snapshot = p_snapshot, last_edited_at = now()
    WHERE id = v_last.id;
    PERFORM public.audit_log_write('post_version_create','success',p_trace_id,v_ws,'post_version',v_last.id::text,
            jsonb_build_object('post_id',p_post_id,'version_number',v_last.version_number,'folded',true));
    RETURN v_last.id;
  END IF;

  SELECT coalesce(max(version_number),0) + 1 INTO v_n FROM public.post_versions WHERE post_id = p_post_id;
  INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
  VALUES (p_post_id, v_ws, v_n, p_snapshot, auth.uid()) RETURNING id INTO v_id;
  PERFORM public.audit_log_write('post_version_create','success',p_trace_id,v_ws,'post_version',v_id::text,
          jsonb_build_object('post_id',p_post_id,'version_number',v_n,'folded',false));
  RETURN v_id;
END; $function$;
