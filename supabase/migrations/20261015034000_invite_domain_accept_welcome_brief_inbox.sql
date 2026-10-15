-- Induction 5/7: member_accept writes a welcome inbox entry for the invitee;
-- brief_create writes brief_created inbox entries for owner, admin and agency members except the actor.
-- member_invite (client domain rules) is recorded in 20261015036000_brand_agency_requests.sql
-- because that file holds its current live body.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; bodies copied verbatim from live.
CREATE OR REPLACE FUNCTION public.member_accept(p_invite_id uuid, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_user uuid; v_email text; v_join boolean; v_wsname text; v_platform text;
BEGIN
  SELECT workspace_id, user_id, join_default_group INTO v_ws, v_user, v_join
    FROM public.workspace_members WHERE id = p_invite_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF v_user IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.workspace_members SET active = true, accepted_at = now()
  WHERE id = p_invite_id AND active = false AND accepted_at IS NULL AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public.audit_log_write('member_accept','success',p_trace_id,v_ws,'workspace_member',p_invite_id::text,NULL);
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user;
  IF v_email IS NOT NULL THEN
    UPDATE public.comments c
    SET author_user_id = v_user, legacy_author_name = NULL, legacy_author_email = NULL
    WHERE c.workspace_id = v_ws AND c.legacy_author_name IS NOT NULL AND c.legacy_author_email = v_email;
  END IF;
  IF v_join THEN
    INSERT INTO public.group_members (group_id, user_id, workspace_id)
    SELECT g.id, v_user, v_ws FROM public.groups g
     WHERE g.workspace_id = v_ws AND g.is_default AND g.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
  SELECT name, platform INTO v_wsname, v_platform FROM public.workspaces WHERE id = v_ws;
  PERFORM public.inbox_entry_create(v_user, v_ws, 'system', 'workspace', v_ws::text,
    'everything', NULL, 'ambient',
    jsonb_build_object('kind','welcome','workspace_name',v_wsname,'platform',v_platform),
    p_trace_id, NULL);
  RETURN p_invite_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.brief_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_title text; v_obj text; v_version_ids uuid[]; v_uid uuid := auth.uid(); i int; v_number integer;
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
    IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
               WHERE v.id = ANY(v_version_ids) AND v.workspace_id = p_workspace_id
                 AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'attachment not available'; END IF;
  END IF;
  UPDATE public.workspace_counters
     SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id
   RETURNING next_entity_number - 1 INTO v_number;
  IF v_number IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
  BEGIN
    INSERT INTO public.briefs (workspace_id, number, title, objective, format_requested, brand_requirements,
      target_date, reference_links, created_by, created_via)
    VALUES (p_workspace_id, v_number, v_title, v_obj, p_payload->>'format_requested', p_payload->>'brand_requirements',
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
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id,
                                    scope, scope_key, tier, payload, actor_user_id)
  SELECT m.user_id, p_workspace_id, 'brief_created', 'brief', v_id::text,
         'briefs', NULL, 'active',
         jsonb_build_object('title', v_title, 'number', v_number), v_uid
    FROM public.workspace_members m
   WHERE m.workspace_id = p_workspace_id AND m.active
     AND m.role IN ('owner','admin','agency') AND m.user_id <> v_uid;
  PERFORM public.audit_log_write(p_action=>'brief_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'brief', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('title', v_title, 'attachments', coalesce(array_length(v_version_ids,1),0), 'number', v_number));
  RETURN v_id;
END; $function$;
