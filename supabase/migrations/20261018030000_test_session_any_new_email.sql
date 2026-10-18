-- Test site sign-up with a typed email: Start fresh opens sign-up, and the email
-- typed there signs in at once (no link), as a test account removed after 24 hours.
-- An address that already belongs to a real (non-test) account is refused
-- (account_exists), so the test site can never sign anyone into a real account.
-- An existing test account (a test address, or one made here) gets a new password,
-- as the invitee path did. Still test-site origin only, still 100 new an hour.
--
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP after Shubham's approval.

CREATE OR REPLACE FUNCTION public.test_session_create(p_email text, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_email text; v_password text := encode(extensions.gen_random_bytes(18), 'hex');
  v_uid uuid; v_invite uuid; v_test boolean;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public._test_site_origin_ok() THEN RAISE EXCEPTION 'test_site_only'; END IF;

  IF p_email IS NULL THEN
    v_email := 'tester-' || substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8) || '@test.srtd.io';
  ELSE
    v_email := lower(trim(p_email));
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN
      RAISE EXCEPTION 'invalid_email';
    END IF;
    SELECT id, (raw_app_meta_data ->> 'test_account') = 'true' INTO v_uid, v_test
      FROM auth.users WHERE lower(email) = v_email;
    IF v_uid IS NOT NULL AND NOT (coalesce(v_test, false) OR public._is_test_email(v_email)) THEN
      RAISE EXCEPTION 'account_exists';
    END IF;
  END IF;

  IF v_uid IS NULL THEN
    IF (SELECT count(*) FROM auth.users
         WHERE raw_app_meta_data ->> 'test_account' = 'true'
           AND created_at > now() - interval '1 hour') >= 100 THEN
      RAISE EXCEPTION 'rate_limited';
    END IF;
    v_uid := gen_random_uuid();
    INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            is_sso_user, is_anonymous)
    VALUES ('00000000-0000-0000-0000-000000000000'::uuid, v_uid, 'authenticated', 'authenticated', v_email,
            extensions.crypt(v_password, extensions.gen_salt('bf')), now(), '', '', '', '',
            jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'),
                               'test_account', true),
            '{}'::jsonb, now(), now(), false, false);
    INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at,
                                 created_at, updated_at)
    VALUES (gen_random_uuid(), v_uid, v_uid::text, 'email',
            jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
            now(), now(), now());
  ELSE
    SELECT wm.id INTO v_invite FROM public.workspace_members wm
     WHERE wm.user_id = v_uid AND NOT wm.active AND wm.accepted_at IS NULL AND wm.removed_at IS NULL
     ORDER BY wm.invited_at DESC LIMIT 1;
    UPDATE auth.users
       SET encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('test_account', true),
           banned_until = NULL, updated_at = now()
     WHERE id = v_uid;
    IF NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = v_uid AND provider = 'email') THEN
      INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at,
                                   created_at, updated_at)
      VALUES (gen_random_uuid(), v_uid, v_uid::text, 'email',
              jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
              now(), now(), now());
    END IF;
  END IF;

  PERFORM public.audit_log_write('test_session_create', 'success', p_trace_id, NULL, 'user', v_uid::text,
    jsonb_build_object('typed_email', p_email IS NOT NULL));
  RETURN jsonb_build_object('email', v_email, 'password', v_password, 'invite_id', v_invite);
END; $function$;
REVOKE EXECUTE ON FUNCTION public.test_session_create(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.test_session_create(text, uuid) TO anon, authenticated;
