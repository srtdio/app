-- Induction 7/7: a brand without an agency asks one to join (capped at 5 sends per open request);
-- the request is fulfilled when that user is invited as a client. member_invite also enforces
-- client email domains (free_mail_client, client_domain_mismatch) and records client_domain
-- from the first client invite.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; bodies copied verbatim from live.
CREATE TABLE IF NOT EXISTS public.brand_agency_requests (
  id uuid NOT NULL DEFAULT uuidv7(),
  requested_by uuid NOT NULL,
  agency_email text NOT NULL,
  brand_name text,
  send_count smallint NOT NULL DEFAULT 1,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_agency_requests_pkey PRIMARY KEY (id),
  CONSTRAINT brand_agency_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT brand_agency_requests_agency_email_check CHECK ((agency_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'::text)),
  CONSTRAINT brand_agency_requests_brand_name_check CHECK (((brand_name IS NULL) OR ((char_length(brand_name) >= 1) AND (char_length(brand_name) <= 80)))),
  CONSTRAINT brand_agency_requests_send_count_check CHECK (((send_count >= 1) AND (send_count <= 5)))
);

CREATE UNIQUE INDEX IF NOT EXISTS brand_agency_requests_one_open
  ON public.brand_agency_requests USING btree (requested_by) WHERE (fulfilled_at IS NULL);

ALTER TABLE public.brand_agency_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brand_agency_requests_select_own ON public.brand_agency_requests;
CREATE POLICY brand_agency_requests_select_own ON public.brand_agency_requests
  FOR SELECT TO authenticated USING ((requested_by = auth.uid()));

-- Writes go through brand_agency_request and member_invite only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.brand_agency_requests FROM authenticated, anon;
REVOKE SELECT ON public.brand_agency_requests FROM anon;
GRANT SELECT ON public.brand_agency_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.brand_agency_request(p_agency_email text, p_brand_name text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_email text := lower(trim(p_agency_email));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  IF v_email IS NULL OR v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT id INTO v_id FROM public.brand_agency_requests
   WHERE requested_by = auth.uid() AND fulfilled_at IS NULL FOR UPDATE;
  IF v_id IS NULL THEN
    INSERT INTO public.brand_agency_requests (requested_by, agency_email, brand_name)
    VALUES (auth.uid(), v_email, nullif(trim(p_brand_name),'')) RETURNING id INTO v_id;
  ELSE
    UPDATE public.brand_agency_requests
       SET agency_email = v_email, brand_name = coalesce(nullif(trim(p_brand_name),''), brand_name),
           send_count = send_count + 1, last_sent_at = now()
     WHERE id = v_id AND send_count < 5;
    IF NOT FOUND THEN RAISE EXCEPTION 'too_many_requests'; END IF;
  END IF;
  PERFORM public.audit_log_write('brand_agency_request','success',p_trace_id,NULL,'brand_agency_request',v_id::text,
    jsonb_build_object('agency_domain', split_part(v_email,'@',2)));
  RETURN v_id;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.brand_agency_request(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.brand_agency_request(text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.member_invite(p_workspace_id uuid, p_email text, p_role text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid; v_id uuid; v_domain text; v_client_domain text; v_has_clients boolean;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id,'workspace.manage_members') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_role NOT IN ('admin','agency','client') OR p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF p_role = 'client' THEN
    v_domain := lower(split_part(trim(p_email),'@',2));
    IF v_domain = ANY (ARRAY['gmail.com','googlemail.com','yahoo.com','yahoo.in','yahoo.co.in','ymail.com',
        'hotmail.com','live.com','msn.com','icloud.com','me.com','aol.com','mail.com','proton.me',
        'protonmail.com','rediffmail.com','zohomail.in','gmx.com','yandex.com']) THEN
      RAISE EXCEPTION 'free_mail_client';
    END IF;
    SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
    IF v_client_domain IS NOT NULL THEN
      IF NOT (v_domain = v_client_domain OR v_domain LIKE '%.' || v_client_domain) THEN
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
