-- RECORD ONLY. Already applied to live v2 via Supabase MCP. Do NOT execute.
--
-- brief_create now accepts an optional payload field attachment_asset_version_ids
-- (an ordered array of asset_version ids, any kind: image/video/pdf/Office-doc/link).
-- Briefs are immutable after creation, so creation is the only attach point. Each id
-- is bound to the new brief as an asset_attachments row with entity_type='brief',
-- entity_id = the brief id, position = array order. The proc signature is UNCHANGED
-- (p_workspace_id uuid, p_payload jsonb, p_trace_id uuid); the new field rides inside
-- p_payload. Cross-tenant or non-uuid ids raise invalid_payload and write nothing.
CREATE OR REPLACE FUNCTION public.brief_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_title text; v_obj text; v_version_ids uuid[]; v_uid uuid := auth.uid(); i int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id, 'brief.create') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  v_title := p_payload->>'title'; v_obj := p_payload->>'objective';
  IF v_title IS NULL OR v_obj IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_payload ? 'attachment_asset_version_ids' THEN
    IF jsonb_typeof(p_payload->'attachment_asset_version_ids') <> 'array' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    BEGIN
      SELECT array_agg(value::uuid) INTO v_version_ids
      FROM jsonb_array_elements_text(p_payload->'attachment_asset_version_ids');
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_payload';
    END;
  END IF;
  IF v_version_ids IS NOT NULL AND array_length(v_version_ids,1) IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(v_version_ids) av(id)
               LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=p_workspace_id
               WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  BEGIN
    INSERT INTO public.briefs (workspace_id, title, objective, format_requested, brand_requirements,
      target_date, reference_links, created_by, created_via)
    VALUES (p_workspace_id, v_title, v_obj, p_payload->>'format_requested', p_payload->>'brand_requirements',
      (p_payload->>'target_date')::date, p_payload->'reference_links', v_uid,
      coalesce(p_payload->>'created_via','app'))
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF v_version_ids IS NOT NULL AND array_length(v_version_ids,1) IS NOT NULL THEN
    FOR i IN 1..array_length(v_version_ids,1) LOOP
      INSERT INTO public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      SELECT v.asset_id, v.id, 'brief', v_id::text, p_workspace_id, i-1, v_uid
      FROM public.asset_versions v WHERE v.id=v_version_ids[i];
    END LOOP;
  END IF;
  PERFORM public.audit_log_write(p_action=>'brief_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'brief', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('title', v_title, 'attachments', coalesce(array_length(v_version_ids,1),0)));
  RETURN v_id;
END; $$;
