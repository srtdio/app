-- Induction 4/7: workspace_create takes a platform (default linkedin), names the default group
-- "<client> - <Platform label>" and writes a welcome inbox entry for the creator.
-- post_create takes the platform from the workspace (payload platform is ignored) and refuses
-- formats the workspace platform does not offer (invalid_format).
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; bodies copied verbatim from live.
CREATE OR REPLACE FUNCTION public.workspace_create(p_payload jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid; v_uid uuid := auth.uid(); v_name text; v_timezone text; v_key text;
  v_base text; v_candidate text; i int; v_gname text; v_gid uuid;
  v_platform text; v_label text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  v_name     := p_payload->>'name';
  v_timezone := p_payload->>'timezone';
  IF v_name IS NULL OR v_timezone IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_platform := coalesce(nullif(p_payload->>'platform',''),'linkedin');
  v_label := CASE v_platform
    WHEN 'instagram' THEN 'Instagram' WHEN 'x' THEN 'X' WHEN 'threads' THEN 'Threads'
    WHEN 'linkedin' THEN 'LinkedIn' WHEN 'facebook' THEN 'Facebook'
    WHEN 'tiktok' THEN 'TikTok' WHEN 'youtube_shorts' THEN 'YouTube Shorts' END;
  IF v_label IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_key := nullif(upper(trim(coalesce(p_payload->>'key',''))),'');
  IF v_key IS NOT NULL THEN
    IF v_key !~ '^[A-Z][A-Z0-9]{1,4}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    IF EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_key) THEN RAISE EXCEPTION 'workspace_key_taken'; END IF;
  ELSE
    SELECT string_agg(left(w,1),'') INTO v_base
      FROM regexp_split_to_table(trim(regexp_replace(upper(v_name),'[^A-Z0-9 ]','','g')),'\s+') AS w WHERE w <> '';
    IF v_base IS NULL OR length(v_base) < 2 THEN v_base := left(regexp_replace(upper(v_name),'[^A-Z0-9]','','g'),4); END IF;
    IF v_base IS NULL OR length(v_base) < 2 OR v_base !~ '^[A-Z]' THEN v_base := 'WS'; END IF;
    v_base := left(v_base,5);
    IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_base) THEN v_key := v_base;
    ELSE
      FOR i IN 2..9 LOOP
        v_candidate := left(v_base,4) || i::text;
        IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_candidate) THEN v_key := v_candidate; EXIT; END IF;
      END LOOP;
    END IF;
    IF v_key IS NULL THEN RAISE EXCEPTION 'workspace_key_taken'; END IF;
  END IF;
  BEGIN
    INSERT INTO public.workspaces (name, owner_user_id, timezone, key, platform)
    VALUES (v_name, v_uid, v_timezone, v_key, v_platform) RETURNING id INTO v_id;
    INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
    VALUES (v_id, v_uid, 'owner', now());
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'workspace_key_taken';
    WHEN check_violation OR not_null_violation OR invalid_text_representation
      OR foreign_key_violation THEN RAISE EXCEPTION 'invalid_payload';
  END;
  v_gname := trim(regexp_replace(regexp_replace(replace(v_name,'&',' and '),'[^A-Za-z0-9 -]','','g'),'\s+',' ','g'));
  IF v_gname = '' THEN v_gname := 'Team'; END IF;
  v_gname := trim(left(v_gname, 40 - length(' - ' || v_label))) || ' - ' || v_label;
  v_gid := public.group_create(v_id, v_gname, '{}'::uuid[], p_trace_id);
  UPDATE public.groups SET is_default = true WHERE id = v_gid;
  PERFORM public.inbox_entry_create(v_uid, v_id, 'system', 'workspace', v_id::text,
    'everything', NULL, 'ambient',
    jsonb_build_object('kind','welcome','workspace_name',v_name,'platform',v_platform),
    p_trace_id, NULL);
  PERFORM public.audit_log_write('workspace_create','success',p_trace_id,v_id,'workspace',v_id::text,
    jsonb_build_object('name',v_name,'timezone',v_timezone,'key',v_key,'platform',v_platform,'default_group_id',v_gid));
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid; v_title text; v_platform text; v_format text;
  v_origin text; v_owner uuid; v_brief uuid; v_number integer;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id,'post.create') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  v_title := p_payload->>'title';
  IF v_title IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT platform INTO v_platform FROM public.workspaces WHERE id = p_workspace_id;
  v_format := coalesce(p_payload->>'format','text');
  IF NOT (v_format = ANY (CASE v_platform
      WHEN 'instagram'      THEN ARRAY['reel','story','carousel','single_image']
      WHEN 'x'              THEN ARRAY['text','single_image','video','thread']
      WHEN 'threads'        THEN ARRAY['text','single_image','carousel','video']
      WHEN 'linkedin'       THEN ARRAY['text','single_image','carousel','video','link']
      WHEN 'facebook'       THEN ARRAY['text','single_image','carousel','video','reel','story','link']
      WHEN 'tiktok'         THEN ARRAY['video']
      WHEN 'youtube_shorts' THEN ARRAY['short']
    END)) THEN RAISE EXCEPTION 'invalid_format'; END IF;
  v_origin := coalesce(p_payload->>'origin','manual');
  v_owner  := coalesce((p_payload->>'owner_user_id')::uuid, auth.uid());
  v_brief  := (p_payload->>'brief_id')::uuid;
  IF v_origin = 'brief' AND v_brief IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.workspace_counters SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id RETURNING next_entity_number - 1 INTO v_number;
  IF v_number IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
  BEGIN
    INSERT INTO public.posts (workspace_id, number, title, caption, bucket_id, owner_user_id,
      platform, format, origin, brief_id, target_date, created_by)
    VALUES (p_workspace_id, v_number, v_title, p_payload->>'caption', (p_payload->>'bucket_id')::uuid, v_owner,
      v_platform, v_format, v_origin, v_brief, (p_payload->>'target_date')::timestamptz, auth.uid())
    RETURNING id INTO v_id;
    INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
    VALUES (v_id, p_workspace_id, 1,
      jsonb_build_object('title',v_title,'caption',p_payload->>'caption','platform',v_platform,
        'format',v_format,'target_date',p_payload->>'target_date','bucket_id',p_payload->>'bucket_id',
        'owner_user_id',v_owner,'origin',v_origin,'brief_id',v_brief),
      auth.uid());
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR datetime_field_overflow OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  PERFORM public.audit_log_write('post_create','success',p_trace_id,p_workspace_id,'post',v_id::text,
    jsonb_build_object('title',v_title,'stage','draft','origin',v_origin,'number',v_number));
  RETURN v_id;
END; $function$;
