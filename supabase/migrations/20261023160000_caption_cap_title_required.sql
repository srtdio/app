-- Schema already applied to movnexawfhsyuluspxoc. Do NOT execute. Caption cap 4000 (caption_too_long), blank title refused (title_required).

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
  IF p_caption IS NULL OR length(p_caption) < 1 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF length(p_caption) > 4000 THEN RAISE EXCEPTION 'caption_too_long'; END IF;
  IF v_old IS NOT DISTINCT FROM p_caption THEN
    SELECT id INTO v_ver FROM public.post_versions WHERE post_id=p_post_id ORDER BY version_number DESC LIMIT 1;
    IF v_ver IS NOT NULL THEN RETURN v_ver; END IF;
  END IF;
  UPDATE public.posts SET caption=p_caption, row_version=row_version+1, updated_at=now() WHERE id=p_post_id;
  v_ver := public.post_version_create(p_post_id, public._post_snapshot(p_post_id), p_trace_id);
  PERFORM public.audit_log_write('post_caption_update','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('version_id',v_ver));
  RETURN v_ver;
END; $function$
;

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
  IF v_title IS NULL OR btrim(v_title) = '' THEN RAISE EXCEPTION 'title_required'; END IF;
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
  IF char_length(coalesce(p_payload->>'caption','')) > 4000 THEN RAISE EXCEPTION 'caption_too_long'; END IF;
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
  IF v_brief IS NOT NULL THEN
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id,
                                      scope, scope_key, tier, payload, actor_user_id)
    SELECT wm.user_id, p_workspace_id, 'brief_post_created', 'post', v_id::text, 'briefs', v_brief::text, 'active',
           jsonb_build_object('post_title', v_title, 'post_number', v_number, 'brief_id', v_brief,
                              'brief_title', b.title, 'brief_number', b.number), auth.uid()
      FROM public.workspace_members wm JOIN public.briefs b ON b.id = v_brief
     WHERE wm.workspace_id = p_workspace_id AND wm.active = true AND wm.user_id <> auth.uid()
       AND (wm.role IN ('owner','admin','agency')
            OR EXISTS (SELECT 1 FROM public.workspace_role_permissions r
                        WHERE r.workspace_id = p_workspace_id AND r.role = wm.role
                          AND r.capability = 'pipeline.view_all_stages' AND r.allowed = true));
    PERFORM public.inbox_self_entry(p_workspace_id, 'brief_post_created', 'post', v_id::text, 'briefs', v_brief::text,
      (SELECT jsonb_build_object('post_title', v_title, 'post_number', v_number, 'brief_id', v_brief,
                                 'brief_title', b.title, 'brief_number', b.number)
         FROM public.briefs b WHERE b.id = v_brief));
  END IF;
  RETURN v_id;
END; $function$
;
