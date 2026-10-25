-- Already applied live to movnexawfhsyuluspxoc on 2026-10-25 (approved by
-- Shubham). Records three changes; nothing else (the one-off test-data step
-- that moved 35 soft-deleted workspaces' deleted_at back 30 days is not part
-- of this migration).
--
-- 1. workspaces_asset_bucket_immutable: asset_bucket stays permanent unless the
--    transaction-local flag sorted.storage_cutover is 'on', which only
--    storage_workspace_cutover sets. Pins search_path to ''.
-- 2. storage_workspace_cutover(p_workspace_id, p_bucket, p_trace_id): service
--    role only. Repoints a live workspace's asset_bucket under the cutover
--    flag, bumping row_version by 1 (workspaces_enforce_row_version); the
--    same bucket is a no-op; a change writes an audit_log row.
--    The index workspaces_asset_bucket_active_uk is untouched.
-- 3. workspace_purge_due: 30-day restore window (deleted_at older than
--    now() - 30 days). Same signature; grants unchanged.

CREATE OR REPLACE FUNCTION public.workspaces_asset_bucket_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $f$ BEGIN IF old.asset_bucket IS NOT NULL AND new.asset_bucket IS DISTINCT FROM old.asset_bucket AND coalesce(current_setting('sorted.storage_cutover', true), '') <> 'on' THEN RAISE EXCEPTION 'asset_bucket is permanent and cannot be changed'; END IF; RETURN new; END $f$;

CREATE OR REPLACE FUNCTION public.storage_workspace_cutover(p_workspace_id uuid, p_bucket text, p_trace_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $f$ DECLARE v_old text; BEGIN IF p_trace_id IS NULL THEN RAISE EXCEPTION 'trace_id required'; END IF; IF p_bucket IS NULL OR p_bucket !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' THEN RAISE EXCEPTION 'invalid bucket'; END IF; SELECT asset_bucket INTO v_old FROM public.workspaces WHERE id = p_workspace_id AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found'; END IF; IF v_old IS NOT DISTINCT FROM p_bucket THEN RETURN; END IF; PERFORM set_config('sorted.storage_cutover', 'on', true); UPDATE public.workspaces SET asset_bucket = p_bucket, row_version = row_version + 1 WHERE id = p_workspace_id; PERFORM set_config('sorted.storage_cutover', 'off', true); INSERT INTO public.audit_log (workspace_id, action, entity_type, entity_id, payload, outcome, trace_id) VALUES (p_workspace_id, 'storage_workspace_cutover', 'workspace', p_workspace_id::text, jsonb_build_object('from', v_old, 'to', p_bucket), 'success', p_trace_id); END $f$;
REVOKE ALL ON FUNCTION public.storage_workspace_cutover(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_workspace_cutover(uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.workspace_purge_due() RETURNS TABLE(workspace_id uuid, bucket text, deleted_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$ select id, asset_bucket, deleted_at from public.workspaces where deleted_at is not null and deleted_at < now() - interval '30 days' order by deleted_at limit 50; $f$;
