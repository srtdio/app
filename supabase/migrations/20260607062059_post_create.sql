-- Already applied to v2 via MCP on 2026-06-07. Do NOT execute.
ALTER TABLE public.posts ALTER COLUMN bucket_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION public.post_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_id uuid; v_title text; v_platform text; v_format text; v_origin text; v_owner uuid; v_brief uuid;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id,'post.create') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  v_title := p_payload->>'title'; v_platform := p_payload->>'platform';
  IF v_title IS NULL OR v_platform IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_format := coalesce(p_payload->>'format','text'); v_origin := coalesce(p_payload->>'origin','manual');
  v_owner := coalesce((p_payload->>'owner_user_id')::uuid, auth.uid()); v_brief := (p_payload->>'brief_id')::uuid;
  IF v_origin = 'brief' AND v_brief IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    INSERT INTO public.posts (workspace_id, title, caption, bucket_id, owner_user_id, platform, format, origin, brief_id, target_date, created_by)
    VALUES (p_workspace_id, v_title, p_payload->>'caption', (p_payload->>'bucket_id')::uuid, v_owner, v_platform, v_format, v_origin, v_brief, (p_payload->>'target_date')::timestamptz, auth.uid())
    RETURNING id INTO v_id;
    INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
    VALUES (v_id, p_workspace_id, 1, jsonb_build_object('title',v_title,'caption',p_payload->>'caption','platform',v_platform,'format',v_format,'target_date',p_payload->>'target_date','bucket_id',p_payload->>'bucket_id','owner_user_id',v_owner,'origin',v_origin,'brief_id',v_brief), auth.uid());
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow OR foreign_key_violation THEN RAISE EXCEPTION 'invalid_payload'; END;
  PERFORM public.audit_log_write('post_create','success',p_trace_id,p_workspace_id,'post',v_id::text,jsonb_build_object('title',v_title,'stage','draft','origin',v_origin));
  RETURN v_id;
END; $function$;
REVOKE EXECUTE ON FUNCTION public.post_create(uuid,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_create(uuid,jsonb,uuid) TO authenticated;
