-- Test-site accounts may invite any address again (20261018010000 limited them to
-- test.srtd.io, which refused every real work email Shubham tried on the test site).
-- member_invite_check is back to its 20261017150000-era body.
--
-- Applied to v2 (movnexawfhsyuluspxoc) on 2026-10-18 via Supabase MCP.

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
