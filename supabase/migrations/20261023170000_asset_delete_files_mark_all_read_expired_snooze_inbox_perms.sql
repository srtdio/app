-- 1. asset_delete / asset_delete_many: the assets_deleted payload also carries
--    'files': [{asset_version_id, filename, mime_type}, ...up to 3] from the
--    current version, so the Activity card can show a thumbnail. 'count' and
--    'filenames' are unchanged.
-- 2. inbox_mark_all_read also clears rows whose snooze has run out.
-- 3. anon/authenticated lose TRUNCATE, REFERENCES, TRIGGER, MAINTAIN on
--    inbox_entries and all its partitions. SELECT is unchanged.

CREATE OR REPLACE FUNCTION public.asset_delete(p_asset_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_name text; v_role text; v_files jsonb;
BEGIN
  SELECT workspace_id INTO v_ws
    FROM public.assets WHERE id = p_asset_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF public.asset_in_use(p_asset_id) THEN RAISE EXCEPTION 'asset_in_use'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;
  UPDATE public.assets SET deleted_at = now() WHERE id = p_asset_id RETURNING filename INTO v_name;
  SELECT jsonb_build_array(jsonb_build_object('asset_version_id', a.current_version_id,
           'filename', a.filename, 'mime_type', av.mime_type))
    INTO v_files
    FROM public.assets a LEFT JOIN public.asset_versions av ON av.id = a.current_version_id
   WHERE a.id = p_asset_id;
  PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',p_asset_id::text);
  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid() AND wm.active = true;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text, 'active',
         jsonb_build_object('count', 1, 'filenames', jsonb_build_array(v_name), 'files', v_files, 'actor_role', v_role), auth.uid()
    FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  PERFORM public.inbox_self_entry(v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text,
    jsonb_build_object('count', 1, 'filenames', jsonb_build_array(v_name), 'files', v_files, 'actor_role', v_role));
END; $function$;

CREATE OR REPLACE FUNCTION public.asset_delete_many(p_asset_ids uuid[], p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_ws uuid;
  v_distinct integer;
  v_id uuid;
  v_ids uuid[];
  v_names text[];
  v_files jsonb;
  v_role text;
BEGIN
  IF p_asset_ids IS NULL OR array_length(p_asset_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF array_length(p_asset_ids, 1) > 200 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT count(DISTINCT workspace_id), (array_agg(DISTINCT workspace_id))[1]
    INTO v_distinct, v_ws
    FROM public.assets
    WHERE id = ANY(p_asset_ids) AND deleted_at IS NULL;

  IF v_ws IS NULL OR v_distinct <> 1 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets
             WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_asset_ids) x(id) WHERE public.asset_in_use(x.id)) THEN RAISE EXCEPTION 'asset_in_use'; END IF;

  WITH deleted AS (
    UPDATE public.assets SET deleted_at = now()
      WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL
      RETURNING id, filename, current_version_id
  ), firsts AS (
    SELECT d.filename, d.current_version_id, av.mime_type
      FROM deleted d LEFT JOIN public.asset_versions av ON av.id = d.current_version_id
     ORDER BY d.filename, d.id
     LIMIT 3
  )
  SELECT (SELECT array_agg(id) FROM deleted),
         (SELECT array_agg(filename ORDER BY filename) FROM firsts),
         (SELECT jsonb_agg(jsonb_build_object('asset_version_id', current_version_id,
                   'filename', filename, 'mime_type', mime_type) ORDER BY filename) FROM firsts)
    INTO v_ids, v_names, v_files;

  IF v_ids IS NULL THEN RETURN; END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',v_id::text);
  END LOOP;

  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid() AND wm.active = true;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text, 'active',
         jsonb_build_object('count', cardinality(v_ids), 'filenames', to_jsonb(v_names), 'files', v_files, 'actor_role', v_role), auth.uid()
    FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  PERFORM public.inbox_self_entry(v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text,
    jsonb_build_object('count', cardinality(v_ids), 'filenames', to_jsonb(v_names), 'files', v_files, 'actor_role', v_role));
END; $function$;

CREATE OR REPLACE FUNCTION public.inbox_mark_all_read(p_workspace_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_n int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.inbox_entries SET read_at = now()
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
     AND read_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= now()) AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_mark_all_read','success',p_trace_id,p_workspace_id,'inbox_entry',NULL::text,jsonb_build_object('count',v_n));
  END IF;
END; $function$;

DO $$
DECLARE r regclass;
BEGIN
  FOR r IN
    SELECT 'public.inbox_entries'::regclass
    UNION ALL
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'public.inbox_entries'::regclass
  LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON %s FROM anon, authenticated', r);
  END LOOP;
END $$;
