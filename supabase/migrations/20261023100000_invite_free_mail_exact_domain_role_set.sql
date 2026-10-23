-- Applied to movnexawfhsyuluspxoc via Supabase MCP on 23 Oct 2026. Free email allowed for approvers; company email must equal client domain or a sub-domain, or an approved address; client domain learnt from first company email; new member_role_set; one-time client_domain fill.

-- 1a
CREATE OR REPLACE FUNCTION public.member_invite_check(p_workspace_id uuid, p_email text, p_role text)
 RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_inviter_role text; v_domain text; v_client_domain text;
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
    IF NOT public.is_free_mail_domain(v_domain) THEN
      SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id;
      IF v_client_domain IS NOT NULL AND NOT (
           v_domain = v_client_domain OR v_domain LIKE '%.' || v_client_domain
        OR EXISTS (SELECT 1 FROM public.workspace_client_domains d
                    WHERE d.workspace_id = p_workspace_id AND d.removed_at IS NULL
                      AND (v_domain = d.domain OR v_domain LIKE '%.' || d.domain))
      ) THEN RAISE EXCEPTION 'client_domain_mismatch'; END IF;
    END IF;
  END IF;
END $function$;

-- 1b
CREATE OR REPLACE FUNCTION public.member_invite(p_workspace_id uuid, p_email text, p_role text, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid; v_id uuid; v_domain text; v_client_domain text;
BEGIN
  IF p_role = 'client' THEN
    SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  END IF;
  PERFORM public.member_invite_check(p_workspace_id, p_email, p_role);
  v_domain := lower(split_part(trim(p_email),'@',2));
  IF p_role = 'client' AND v_client_domain IS NULL AND NOT public.is_free_mail_domain(v_domain) THEN
    UPDATE public.workspaces SET client_domain = v_domain, row_version = row_version + 1
     WHERE id = p_workspace_id;
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

-- 1c
CREATE OR REPLACE FUNCTION public.member_role_set(p_member_id uuid, p_role text, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_ws uuid; v_user uuid; v_old text; v_email text;
BEGIN
  SELECT workspace_id, user_id, role INTO v_ws, v_user, v_old FROM public.workspace_members
   WHERE id = p_member_id AND active AND removed_at IS NULL FOR UPDATE;
  IF v_ws IS NULL OR p_role IS NULL OR p_role NOT IN ('admin','agency','client') THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.proc_capability(v_ws,'workspace.manage_members') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_old = 'owner' OR v_user = auth.uid() THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_old = p_role THEN RETURN p_member_id; END IF;
  IF p_role = 'client' THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_user;
    PERFORM public.member_invite_check(v_ws, v_email, 'client');
  END IF;
  UPDATE public.workspace_members SET role = p_role WHERE id = p_member_id;
  PERFORM public.audit_log_write('member_role_set','success',p_trace_id,v_ws,'workspace_member',
          p_member_id::text, jsonb_build_object('from',v_old,'to',p_role));
  RETURN p_member_id;
END $function$;

-- 1d
REVOKE ALL ON FUNCTION public.member_role_set(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_role_set(uuid,text,uuid) TO authenticated;

-- 1e (one-time fill)
UPDATE public.workspaces w SET client_domain = x.d, row_version = w.row_version + 1
FROM (SELECT m.workspace_id, min(split_part(lower(u.email),'@',2)) d
        FROM public.workspace_members m JOIN auth.users u ON u.id = m.user_id
       WHERE m.role='client' AND m.removed_at IS NULL
         AND NOT public.is_free_mail_domain(split_part(lower(u.email),'@',2))
         AND split_part(lower(u.email),'@',2) NOT LIKE '%srtd.io'
       GROUP BY m.workspace_id
      HAVING count(DISTINCT split_part(lower(u.email),'@',2)) = 1) x
WHERE w.id = x.workspace_id AND w.client_domain IS NULL;
