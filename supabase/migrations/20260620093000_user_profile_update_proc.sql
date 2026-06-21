-- user_profile_update: the onboarding / profile write path.
-- Schema already applied to live (project movnexawfhsyuluspxoc). Do NOT execute.
-- Adds the per-user onboarding gate (profile_completed_at) and email opt-in (email_opt_in),
-- plus the SECURITY DEFINER proc that is the only write path to a user's own profile. The
-- proc acts on auth.uid(), stamps profile_completed_at once a photo exists, and records a
-- success audit row. EXECUTE is authenticated only (PUBLIC revoked), matching the other procs.
ALTER TABLE public.users ADD COLUMN profile_completed_at timestamptz;
ALTER TABLE public.users ADD COLUMN email_opt_in boolean NOT NULL DEFAULT true;
CREATE OR REPLACE FUNCTION public.user_profile_update(
  p_display_name text, p_designation text, p_avatar_url text,
  p_email_opt_in boolean, p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_name text := nullif(trim(p_display_name),''); v_done boolean;
BEGIN
  IF v_uid IS NULL OR v_name IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.users SET
    display_name = v_name,
    designation  = coalesce(p_designation, designation),
    avatar_url   = coalesce(p_avatar_url, avatar_url),
    email_opt_in = coalesce(p_email_opt_in, email_opt_in),
    profile_completed_at = CASE
      WHEN profile_completed_at IS NULL AND coalesce(p_avatar_url, avatar_url) IS NOT NULL
      THEN now() ELSE profile_completed_at END
  WHERE id = v_uid
  RETURNING (profile_completed_at IS NOT NULL) INTO v_done;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public.audit_log_write(
    p_action => 'user_profile_update', p_outcome => 'success', p_trace_id => p_trace_id,
    p_entity_type => 'user', p_entity_id => v_uid::text,
    p_payload => jsonb_build_object('completed', v_done, 'email_opt_in', coalesce(p_email_opt_in, true)));
  RETURN v_uid;
END; $$;
REVOKE EXECUTE ON FUNCTION public.user_profile_update(text, text, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_profile_update(text, text, text, boolean, uuid) TO authenticated;
