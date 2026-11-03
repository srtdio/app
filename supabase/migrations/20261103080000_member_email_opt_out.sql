-- Member email opt-out: an owner/admin can switch catch-up emails off/on for
-- a member; users.email_opt_out_by records who turned them off when it was
-- not the person. Set only by the trigger from the transaction-local setting
-- sorted.email_opt_out_by.
-- Applied to live (movnexawfhsyuluspxoc) on 2026-11-03; this file records it.
-- Function bodies copied verbatim from pg_get_functiondef. Idempotent. No DROP.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_opt_out_by uuid
  CONSTRAINT users_email_opt_out_by_fkey REFERENCES public.users(id) ON DELETE SET NULL;

GRANT SELECT (email_opt_out_by) ON public.users TO authenticated;

CREATE OR REPLACE FUNCTION public.users_email_opt_out_by_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.email_opt_in IS DISTINCT FROM OLD.email_opt_in THEN
    NEW.email_opt_out_by := CASE WHEN NEW.email_opt_in THEN NULL
      ELSE nullif(current_setting('sorted.email_opt_out_by', true), '')::uuid END;
  ELSE
    NEW.email_opt_out_by := OLD.email_opt_out_by;
  END IF;
  RETURN NEW;
END $function$
;

DROP TRIGGER IF EXISTS users_email_opt_out_by_trg ON public.users;
CREATE TRIGGER users_email_opt_out_by_trg BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION users_email_opt_out_by_trg();

CREATE OR REPLACE FUNCTION public.member_email_opt_in_set(p_user_id uuid, p_email_opt_in boolean, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid := auth.uid(); v_ws uuid; v_cur boolean; v_by uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF p_user_id IS NULL OR p_email_opt_in IS NULL OR p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023'; END IF;
  IF p_user_id = v_actor THEN RAISE EXCEPTION 'use_own_settings' USING ERRCODE = '22023'; END IF;
  SELECT m.workspace_id INTO v_ws
  FROM workspace_members m
  JOIN workspace_members t ON t.workspace_id = m.workspace_id AND t.user_id = p_user_id AND t.active AND t.removed_at IS NULL
  JOIN workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
  WHERE m.user_id = v_actor AND m.active AND m.removed_at IS NULL AND m.role IN ('owner', 'admin')
  ORDER BY m.workspace_id LIMIT 1;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT email_opt_in, email_opt_out_by INTO v_cur, v_by FROM users WHERE id = p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_cur = p_email_opt_in THEN RETURN p_trace_id; END IF;
  IF p_email_opt_in AND v_by IS NULL THEN RAISE EXCEPTION 'turned_off_by_member' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('sorted.email_opt_out_by', v_actor::text, true);
  UPDATE users SET email_opt_in = p_email_opt_in WHERE id = p_user_id;
  PERFORM set_config('sorted.email_opt_out_by', '', true);
  PERFORM audit_log_write('member_email_opt_in_set', 'success', p_trace_id, v_ws, 'user', p_user_id::text, jsonb_build_object('email_opt_in', p_email_opt_in));
  RETURN p_trace_id;
END $function$
;

REVOKE ALL ON FUNCTION public.member_email_opt_in_set(uuid, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_email_opt_in_set(uuid, boolean, uuid) TO authenticated;
