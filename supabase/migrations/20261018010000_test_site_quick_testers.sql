-- Quick testers for the test site (test.srtdio-app.pages.dev) only: one tap makes a
-- brand-new account with no email, so onboarding can be run again and again, and an
-- invite sent to a test address can be opened as that invitee without an email.
--
-- Test accounts use the address domain test.srtd.io, carry raw_app_meta_data
-- test_account=true, and are removed 24 hours after they were made (their workspaces
-- are soft-deleted first and go through the normal workspace purge). They can only
-- invite other test addresses. The procs refuse any caller whose request Origin is
-- not the test site; srtd.io gets nothing from them.
--
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP after Shubham's approval.

CREATE OR REPLACE FUNCTION public._test_site_origin_ok()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT coalesce(
    (nullif(current_setting('request.headers', true), '')::json ->> 'origin')
      = 'https://test.srtdio-app.pages.dev',
    false);
$function$;
REVOKE EXECUTE ON FUNCTION public._test_site_origin_ok() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._is_test_email(p_email text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT lower(coalesce(p_email, '')) LIKE '%@test.srtd.io';
$function$;
REVOKE EXECUTE ON FUNCTION public._is_test_email(text) FROM PUBLIC, anon, authenticated;

-- A new test account (p_email NULL) or a sign-in for a pending test invitee
-- (p_email = the invited test address). Returns { email, password, invite_id }; the
-- client signs in with the password. 100 new accounts an hour at most.
CREATE OR REPLACE FUNCTION public.test_session_create(p_email text, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_email text; v_password text := encode(extensions.gen_random_bytes(18), 'hex');
  v_uid uuid; v_invite uuid;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public._test_site_origin_ok() THEN RAISE EXCEPTION 'test_site_only'; END IF;

  IF p_email IS NULL THEN
    IF (SELECT count(*) FROM auth.users
         WHERE raw_app_meta_data ->> 'test_account' = 'true'
           AND created_at > now() - interval '1 hour') >= 100 THEN
      RAISE EXCEPTION 'rate_limited';
    END IF;
    v_email := 'tester-' || substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8) || '@test.srtd.io';
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
    v_email := lower(trim(p_email));
    IF NOT public._is_test_email(v_email) THEN RAISE EXCEPTION 'test_address_only'; END IF;
    SELECT id INTO v_uid FROM auth.users WHERE lower(email) = v_email;
    IF v_uid IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
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
    jsonb_build_object('invitee', p_email IS NOT NULL));
  RETURN jsonb_build_object('email', v_email, 'password', v_password, 'invite_id', v_invite);
END; $function$;
REVOKE EXECUTE ON FUNCTION public.test_session_create(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.test_session_create(text, uuid) TO anon, authenticated;

-- A test account may invite only test addresses (no real inbox is ever mailed from
-- a throwaway account). Otherwise member_invite_check as live.
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
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND raw_app_meta_data ->> 'test_account' = 'true')
     AND NOT public._is_test_email(p_email) THEN
    RAISE EXCEPTION 'test_account_test_addresses_only';
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

-- Hourly: test accounts older than 24 hours. Their workspaces are soft-deleted (the
-- normal purge removes them and their files); once nothing they own is left, the
-- account goes. A row that cannot go yet is retried next hour.
CREATE OR REPLACE FUNCTION public._test_accounts_purge()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r record; v_ws int := 0; v_users int := 0;
BEGIN
  FOR r IN SELECT id FROM auth.users
            WHERE raw_app_meta_data ->> 'test_account' = 'true'
              AND created_at < now() - interval '24 hours' LOOP
    WITH soft AS (
      UPDATE public.workspaces SET deleted_at = now()
       WHERE owner_user_id = r.id AND deleted_at IS NULL RETURNING id)
    SELECT v_ws + count(*) INTO v_ws FROM soft;
    UPDATE public.workspace_members SET active = false
     WHERE active AND workspace_id IN (SELECT id FROM public.workspaces WHERE owner_user_id = r.id);
    IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE owner_user_id = r.id) THEN
      BEGIN
        DELETE FROM auth.users WHERE id = r.id;
        v_users := v_users + 1;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL;
      END;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('workspaces_soft_deleted', v_ws, 'accounts_deleted', v_users);
END; $function$;
REVOKE EXECUTE ON FUNCTION public._test_accounts_purge() FROM PUBLIC, anon, authenticated;

-- CI containers have no pg_cron: schedule only where it exists (as 20260710153728 does).
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule('test-accounts-purge')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'test-accounts-purge');
    PERFORM cron.schedule('test-accounts-purge', '17 * * * *', 'SELECT public._test_accounts_purge()');
  END IF;
END $cron$;
