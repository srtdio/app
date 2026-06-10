-- Already applied to remote via Supabase MCP; present for repo history only. Do NOT re-run.
CREATE OR REPLACE FUNCTION public.asset_delete(p_asset_id uuid, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.assets WHERE id = p_asset_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.assets SET deleted_at = now() WHERE id = p_asset_id;
  PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',p_asset_id::text);
END; $$;
REVOKE ALL ON FUNCTION public.asset_delete(uuid,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.asset_delete(uuid,uuid) TO authenticated;
