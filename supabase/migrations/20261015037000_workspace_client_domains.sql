-- Induction 8/8: approver email rule for client invites.
-- Free-mail domains are always refused. Otherwise the brand word of workspaces.client_domain
-- (domain_brand_word) must appear in full in the invitee's brand word (brand words under 4 letters
-- need an exact match), or the invitee domain equals or is a subdomain of an active owner-approved
-- workspace_client_domains row. Only the workspace owner adds or removes rows; removal is soft.
-- member_invite also restores the client-invites-client branch: a client inviter may invite only
-- role client; any other inviter needs workspace.manage_members.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; bodies copied verbatim from live.

CREATE OR REPLACE FUNCTION public.is_free_mail_domain(p_domain text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT lower(p_domain) = ANY (ARRAY['gmail.com','googlemail.com','yahoo.com','yahoo.in','yahoo.co.in','ymail.com',
    'hotmail.com','live.com','msn.com','icloud.com','me.com','aol.com','mail.com','proton.me',
    'protonmail.com','rediffmail.com','zohomail.in','gmx.com','yandex.com','outlook.com']) $function$;

CREATE OR REPLACE FUNCTION public.domain_brand_word(p_domain text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
DECLARE l text[] := string_to_array(lower(p_domain), '.'); n int := coalesce(array_length(l,1),0);
BEGIN
  IF n < 2 THEN RETURN NULL; END IF;
  IF n >= 3 AND length(l[n]) = 2 AND l[n-1] = ANY (ARRAY['co','com','net','org','gov','ac','edu','ltd','plc','gen','firm','ind','biz']) THEN
    RETURN l[n-2];
  END IF;
  RETURN l[n-1];
END $function$;

CREATE TABLE IF NOT EXISTS public.workspace_client_domains (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  domain text NOT NULL,
  approved_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid,
  CONSTRAINT workspace_client_domains_pkey PRIMARY KEY (id),
  CONSTRAINT workspace_client_domains_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_client_domains_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id),
  CONSTRAINT workspace_client_domains_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.users(id),
  CONSTRAINT workspace_client_domains_domain_check CHECK ((domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'::text)),
  CONSTRAINT workspace_client_domains_workspace_id_domain_key UNIQUE (workspace_id, domain)
);

ALTER TABLE public.workspace_client_domains ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'workspace_client_domains'
                  AND policyname = 'workspace_client_domains_select_member') THEN
    CREATE POLICY workspace_client_domains_select_member ON public.workspace_client_domains
      FOR SELECT TO authenticated USING (public.is_active_workspace_member(workspace_id));
  END IF;
END $$;

-- Writes go through workspace_client_domain_add / workspace_client_domain_remove only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.workspace_client_domains FROM authenticated, anon;
REVOKE SELECT ON public.workspace_client_domains FROM anon;
GRANT SELECT ON public.workspace_client_domains TO authenticated;

CREATE OR REPLACE FUNCTION public.workspace_client_domain_add(p_workspace_id uuid, p_domain text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_d text := lower(trim(p_domain));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_d IS NULL OR v_d !~ '^[a-z0-9.-]+\.[a-z]{2,}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF public.is_free_mail_domain(v_d) THEN RAISE EXCEPTION 'free_mail_client'; END IF;
  INSERT INTO public.workspace_client_domains (workspace_id, domain, approved_by)
  VALUES (p_workspace_id, v_d, auth.uid())
  ON CONFLICT (workspace_id, domain) DO UPDATE
    SET approved_by = EXCLUDED.approved_by, removed_at = NULL, removed_by = NULL
  RETURNING id INTO v_id;
  PERFORM public.audit_log_write('workspace_client_domain_add','success',p_trace_id,p_workspace_id,
    'workspace_client_domain',v_id::text,jsonb_build_object('domain',v_d));
  RETURN v_id;
END $function$;

REVOKE EXECUTE ON FUNCTION public.workspace_client_domain_add(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_client_domain_add(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.workspace_client_domain_remove(p_workspace_id uuid, p_domain text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_d text := lower(trim(p_domain));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.workspace_client_domains SET removed_at = now(), removed_by = auth.uid()
   WHERE workspace_id = p_workspace_id AND domain = v_d AND removed_at IS NULL RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  PERFORM public.audit_log_write('workspace_client_domain_remove','success',p_trace_id,p_workspace_id,
    'workspace_client_domain',v_id::text,jsonb_build_object('domain',v_d));
END $function$;

REVOKE EXECUTE ON FUNCTION public.workspace_client_domain_remove(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_client_domain_remove(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.member_invite(p_workspace_id uuid, p_email text, p_role text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid; v_id uuid; v_domain text; v_client_domain text; v_has_clients boolean; v_word text; v_inv text; v_inviter_role text;
BEGIN
  SELECT wm.role INTO v_inviter_role FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
     AND wm.active = true AND wm.removed_at IS NULL;
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
    IF public.is_free_mail_domain(v_domain) THEN
      RAISE EXCEPTION 'free_mail_client';
    END IF;
    SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
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
    ELSE
      SELECT EXISTS (SELECT 1 FROM public.workspace_members
                      WHERE workspace_id = p_workspace_id AND role = 'client' AND removed_at IS NULL)
        INTO v_has_clients;
      IF NOT v_has_clients THEN
        UPDATE public.workspaces SET client_domain = v_domain, row_version = row_version + 1
         WHERE id = p_workspace_id;
      END IF;
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
