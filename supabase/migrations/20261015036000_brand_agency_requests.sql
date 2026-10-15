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
