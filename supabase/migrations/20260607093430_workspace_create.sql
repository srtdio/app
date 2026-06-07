-- workspace_create: client-callable SECURITY DEFINER proc.
-- Already applied to live (movnexawfhsyuluspxoc) via MCP. Commit only.
CREATE OR REPLACE FUNCTION public.workspace_create(p_payload jsonb, p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
  v_timezone text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;

  v_name     := p_payload->>'name';
  v_timezone := p_payload->>'timezone';
  IF v_name IS NULL OR v_timezone IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  BEGIN
    INSERT INTO public.workspaces (name, owner_user_id, timezone)
    VALUES (v_name, v_uid, v_timezone)
    RETURNING id INTO v_id;

    INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
    VALUES (v_id, v_uid, 'owner', now());
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR foreign_key_violation OR unique_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write('workspace_create','success',p_trace_id,v_id,'workspace',v_id::text,
          jsonb_build_object('name',v_name,'timezone',v_timezone));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.workspace_create(jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.workspace_create(jsonb, uuid) TO authenticated;
