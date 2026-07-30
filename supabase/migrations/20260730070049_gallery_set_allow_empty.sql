-- gallery_set: allow an empty gallery.
-- A post may now have zero images: deleting the last image is a supported action.
-- NULL payload is still rejected. Position loop is skipped when the list is empty,
-- because a FOR loop with a null upper bound raises in plpgsql.
-- The no-change shortcut treats a null array_agg and '{}' as equal so repeat calls
-- do not create redundant post_versions.
-- Already applied to the live v2 database. Signature unchanged, so generated types are unaffected.

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
  IF p_asset_version_ids IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_len := COALESCE(array_length(p_asset_version_ids,1),0);
  IF EXISTS (SELECT 1 FROM unnest(p_asset_version_ids) av(id)
             LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=v_ws
             WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
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
