-- member_invite_check: every invite permission and email check, no writes. Used by the
-- invite-send edge function before it creates a login; member_invite delegates its checks to it.
-- member_invite: locks the workspace row for client invites, PERFORMs member_invite_check, then
-- first-client domain set, insert, brand request fulfil, audit.
-- workspace_update: owner/admin (workspace.manage_settings) edit name, logo_url, timezone only;
-- platform is never editable.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026 10:17 IST; bodies copied verbatim from live.

CREATE OR REPLACE FUNCTION public.member_invite_check(p_workspace_id uuid, p_email text, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_inviter_role text; v_domain text; v_client_domain text; v_word text; v_inv text;
BEGIN
  SELECT wm.role INTO v_inviter_role FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid() AND wm.active AND wm.removed_at IS NULL;
  IF v_inviter_role IS NULL THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF v_inviter_role = 'client' THEN
    IF p_role IS DISTINCT FROM 'client' THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  ELSIF NOT public.proc_capability(p_workspace_id,'workspace.manage_members') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin','agency','client') OR p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF p_role = 'client' THEN
    v_domain := lower(split_part(trim(p_email),'@',2));
    IF public.is_free_mail_domain(v_domain) THEN RAISE EXCEPTION 'free_mail_client'; END IF;
    SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id;
    IF v_client_domain IS NOT NULL THEN
      v_word := public.domain_brand_word(v_client_domain);
      v_inv := public.domain_brand_word(v_domain);
      IF NOT (
           (length(v_word) >= 4 AND position(v_word IN v_inv) > 0)
        OR v_inv = v_word
        OR EXISTS (SELECT 1 FROM public.workspace_client_domains d
                    WHERE d.workspace_id = p_workspace_id AND d.removed_at IS NULL
                      AND (v_domain = d.domain OR v_domain LIKE '%.' || d.domain))
      ) THEN
        RAISE EXCEPTION 'client_domain_mismatch';
      END IF;
    END IF;
  END IF;
END $function$;

REVOKE EXECUTE ON FUNCTION public.member_invite_check(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_invite_check(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.member_invite(p_workspace_id uuid, p_email text, p_role text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid; v_id uuid; v_domain text; v_client_domain text; v_has_clients boolean;
BEGIN
  IF p_role = 'client' THEN
    SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  END IF;
  PERFORM public.member_invite_check(p_workspace_id, p_email, p_role);
  IF p_role = 'client' AND v_client_domain IS NULL THEN
    v_domain := lower(split_part(trim(p_email),'@',2));
    SELECT EXISTS (SELECT 1 FROM public.workspace_members
                    WHERE workspace_id = p_workspace_id AND role = 'client' AND removed_at IS NULL)
      INTO v_has_clients;
    IF NOT v_has_clients THEN
      UPDATE public.workspaces SET client_domain = v_domain, row_version = row_version + 1
       WHERE id = p_workspace_id;
    END IF;
  END IF;
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role, active, invited_by, invited_at)
    VALUES (p_workspace_id, v_uid, p_role, false, auth.uid(), now()) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation OR check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF p_role = 'client' THEN
    UPDATE public.brand_agency_requests SET fulfilled_at = now()
     WHERE requested_by = v_uid AND fulfilled_at IS NULL;
  END IF;
  PERFORM public.audit_log_write('member_invite','success',p_trace_id,p_workspace_id,'workspace_member',v_id::text,
          jsonb_build_object('role',p_role));
  RETURN v_id;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.member_invite(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_invite(uuid, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.workspace_update(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_name text; v_logo text; v_tz text; v_keys text[];
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id,'workspace.manage_settings') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(p_payload) k;
  IF v_keys IS NULL OR NOT (v_keys <@ ARRAY['logo_url','name','timezone']) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_payload ? 'name' THEN
    v_name := trim(p_payload->>'name');
    IF v_name IS NULL OR length(v_name) < 1 OR length(v_name) > 80 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  IF p_payload ? 'logo_url' THEN
    v_logo := p_payload->>'logo_url';
    IF v_logo IS NULL OR (v_logo <> '' AND v_logo !~ '^https://') THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  IF p_payload ? 'timezone' THEN
    v_tz := p_payload->>'timezone';
    IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_tz) THEN
      RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  UPDATE public.workspaces SET
    name = CASE WHEN p_payload ? 'name' THEN v_name ELSE name END,
    logo_url = CASE WHEN p_payload ? 'logo_url' THEN nullif(v_logo,'') ELSE logo_url END,
    timezone = CASE WHEN p_payload ? 'timezone' THEN v_tz ELSE timezone END,
    updated_at = now(), row_version = row_version + 1
  WHERE id = p_workspace_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  PERFORM public.audit_log_write('workspace_update','success',p_trace_id,p_workspace_id,'workspace',p_workspace_id::text,
    jsonb_build_object('changed', to_jsonb(v_keys)));
END $function$;

REVOKE EXECUTE ON FUNCTION public.workspace_update(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_update(uuid, jsonb, uuid) TO authenticated;
