-- Change your own username (Settings > Profile). Same rules as onboarding.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 14 Oct 2026; this file records it.
create function public.username_set(p_username text, p_trace_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
DECLARE v_uid uuid := auth.uid(); v_un text := lower(trim(coalesce(p_username, '')));
BEGIN
  IF v_uid IS NULL OR v_un !~ '^[a-z0-9._]{3,20}$'
     OR v_un = ANY (array['admin','support','sorted','srtd','help','team','everyone']) THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  BEGIN
    UPDATE public.users SET username = v_un WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'username_taken';
  END;
  PERFORM public.audit_log_write(p_action => 'username_set', p_outcome => 'success',
    p_trace_id => p_trace_id, p_entity_type => 'user', p_entity_id => v_uid::text,
    p_payload => jsonb_build_object('username', v_un));
  RETURN v_uid;
END; $$;
revoke all on function public.username_set(text, uuid) from public, anon;
grant execute on function public.username_set(text, uuid) to authenticated;
