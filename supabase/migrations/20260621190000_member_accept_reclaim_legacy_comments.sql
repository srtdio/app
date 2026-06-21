-- Already applied via MCP on the v2 project. Recorded for migration parity.
-- Adds the legacy-comment reclaim to member_accept: on invite acceptance, this
-- workspace's migrated v1 comments matching the joining member's email are
-- re-attributed to their account and the frozen legacy label is cleared.
-- CREATE OR REPLACE is idempotent and safe to replay.
CREATE OR REPLACE FUNCTION public.member_accept(p_invite_id uuid, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_user uuid; v_email text;
BEGIN
  SELECT workspace_id, user_id INTO v_ws, v_user FROM public.workspace_members WHERE id = p_invite_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF v_user IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.workspace_members
  SET active = true, accepted_at = now()
  WHERE id = p_invite_id
    AND active = false
    AND accepted_at IS NULL
    AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public.audit_log_write('member_accept','success',p_trace_id,v_ws,'workspace_member',p_invite_id::text,NULL);
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user;
  IF v_email IS NOT NULL THEN
    UPDATE public.comments c
    SET author_user_id = v_user,
        legacy_author_name = NULL,
        legacy_author_email = NULL
    WHERE c.workspace_id = v_ws
      AND c.legacy_author_name IS NOT NULL
      AND c.legacy_author_email = v_email;
  END IF;
  RETURN p_invite_id;
END; $function$;
