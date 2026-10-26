-- Already applied live to movnexawfhsyuluspxoc on 2026-10-26 (approved by
-- Shubham). Records exactly what is live; nothing else.
--
-- 1. Drops workspaces_asset_bucket_active_uk so many workspaces can share the
--    one private bucket srtdio-files.
-- 2. storage_workspace_move(p_workspace_id, p_bucket, p_expected_objects,
--    p_trace_id): service role only. Locks the live workspace, checks that
--    p_expected_objects equals versions with r2_key + renditions with r2_key
--    (else 'object_count_changed', DETAIL = live count), renames every key not
--    already under ws/ or induction-sample/ to the ID-only layout
--      ws/<workspace_id>/<asset_id>/<version_id>/original
--      ws/<workspace_id>/<asset_id>/<version_id>/<role>
--    in one transaction, then calls storage_workspace_cutover.
--
-- DESTRUCTIVE: drops a unique index, no row or column dropped.
-- Rollback (only valid before any second workspace moves to the shared bucket):
-- CREATE UNIQUE INDEX workspaces_asset_bucket_active_uk ON public.workspaces (asset_bucket) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS public.workspaces_asset_bucket_active_uk;

CREATE OR REPLACE FUNCTION public.storage_workspace_move(p_workspace_id uuid, p_bucket text, p_expected_objects integer, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_n integer;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'trace_id required'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found'; END IF;
  SELECT (SELECT count(*) FROM public.asset_versions v WHERE v.workspace_id = p_workspace_id AND v.r2_key IS NOT NULL)
       + (SELECT count(*) FROM public.asset_renditions r WHERE r.workspace_id = p_workspace_id AND r.r2_key IS NOT NULL)
    INTO v_n;
  IF v_n <> p_expected_objects THEN RAISE EXCEPTION 'object_count_changed' USING DETAIL = v_n::text; END IF;
  UPDATE public.asset_versions v
     SET r2_key = 'ws/' || p_workspace_id || '/' || v.asset_id || '/' || v.id || '/original'
   WHERE v.workspace_id = p_workspace_id AND v.r2_key IS NOT NULL
     AND v.r2_key NOT LIKE 'ws/%' AND v.r2_key NOT LIKE 'induction-sample/%';
  UPDATE public.asset_renditions r
     SET r2_key = 'ws/' || p_workspace_id || '/' || v.asset_id || '/' || v.id || '/' || r.role
    FROM public.asset_versions v
   WHERE v.id = r.asset_version_id AND r.workspace_id = p_workspace_id AND r.r2_key IS NOT NULL
     AND r.r2_key NOT LIKE 'ws/%' AND r.r2_key NOT LIKE 'induction-sample/%';
  PERFORM public.storage_workspace_cutover(p_workspace_id, p_bucket, p_trace_id);
END $function$;
REVOKE ALL ON FUNCTION public.storage_workspace_move(uuid,text,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_workspace_move(uuid,text,integer,uuid) TO service_role;
