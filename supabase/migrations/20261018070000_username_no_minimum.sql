-- Usernames may be 1 to 20 characters (was 3 to 20): a person can have a short
-- handle such as "ks". Same characters (a-z, 0-9, dot, underscore) and the same
-- reserved names. Loosens the check only; no row changes.
--
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP after Shubham's approval.

ALTER TABLE public.users DROP CONSTRAINT users_username_format;
ALTER TABLE public.users ADD CONSTRAINT users_username_format
  CHECK (username IS NULL OR username ~ '^[a-z0-9._]{1,20}$');

CREATE OR REPLACE FUNCTION public.username_available(p_username text, p_trace_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select lower(trim(p_username)) ~ '^[a-z0-9._]{1,20}$'
     and lower(trim(p_username)) <> all (array['admin','support','sorted','srtd','help','team','everyone'])
     and not exists (select 1 from public.users
                     where username = lower(trim(p_username)) and id <> auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.username_set(p_username text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_un text := lower(trim(coalesce(p_username, '')));
BEGIN
  IF v_uid IS NULL OR v_un !~ '^[a-z0-9._]{1,20}$'
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
END; $function$;

CREATE OR REPLACE FUNCTION public.user_onboarding_save(p_payload jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := nullif(trim(p_payload->>'display_name'), '');
  v_un text := lower(trim(coalesce(p_payload->>'username', '')));
BEGIN
  IF v_uid IS NULL OR v_name IS NULL OR v_un !~ '^[a-z0-9._]{1,20}$'
     OR v_un = ANY (array['admin','support','sorted','srtd','help','team','everyone']) THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  BEGIN
    UPDATE public.users SET
      display_name = v_name,
      username = v_un,
      designation = nullif(trim(p_payload->>'designation'), ''),
      avatar_url = coalesce(nullif(p_payload->>'avatar_url', ''), avatar_url),
      email_opt_in = coalesce((p_payload->>'email_opt_in')::boolean, email_opt_in),
      profile_completed_at = coalesce(profile_completed_at, now())
    WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    INSERT INTO public.user_private (user_id, age_range, heard_from, updated_at)
    VALUES (v_uid, nullif(p_payload->>'age_range', ''), nullif(p_payload->>'heard_from', ''), now())
    ON CONFLICT (user_id) DO UPDATE
      SET age_range = excluded.age_range, heard_from = excluded.heard_from, updated_at = now();
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'username_taken';
    WHEN check_violation OR invalid_text_representation THEN RAISE EXCEPTION 'invalid_payload';
  END;
  PERFORM public.audit_log_write(
    p_action => 'user_onboarding_save', p_outcome => 'success', p_trace_id => p_trace_id,
    p_entity_type => 'user', p_entity_id => v_uid::text,
    p_payload => jsonb_build_object('has_photo', (p_payload->>'avatar_url') IS NOT NULL));
  RETURN v_uid;
END; $function$;
