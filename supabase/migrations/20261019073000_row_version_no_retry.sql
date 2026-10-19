-- Record of SQL applied live on 19 Oct 2026 via the Supabase SQL editor (v2,
-- movnexawfhsyuluspxoc). Schema already applied; this file keeps the repo in
-- step with the live database.
--
-- Incident: workspace_delete updated workspaces without bumping row_version.
-- The row_version check raised SQLSTATE 40001 (serialization_failure), which
-- PostgREST retries automatically, so one delete looped ~100 times a second
-- for 24 hours. Fixes:
--   1. workspace_delete and _test_accounts_purge bump row_version.
--   2. The four row_version checks raise P0001 (plain error, never retried).
--      Audit: no app code relies on 40001 from these tables, and every write
--      path bumps row_version relative to the current row, so only a coding
--      mistake can trip the check.

create or replace function public.workspace_delete(p_workspace_id uuid, p_confirm_name text, p_trace_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_name text;
begin
  select name into v_name from public.workspaces
   where id = p_workspace_id and owner_user_id = auth.uid() and deleted_at is null
   for update;
  if v_name is null then raise exception 'owner_only'; end if;
  if p_confirm_name is distinct from v_name then raise exception 'confirm_name_mismatch'; end if;
  update public.workspaces set deleted_at = now(), row_version = row_version + 1 where id = p_workspace_id;
  update public.workspace_members set active = false where workspace_id = p_workspace_id and active = true;
  perform public.audit_log_write('workspace_delete','success',p_trace_id,p_workspace_id,'workspace',p_workspace_id::text);
end $function$;

create or replace function public.workspaces_enforce_row_version() returns trigger language plpgsql as $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)', old.row_version, new.row_version using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end; $function$;

create or replace function public.posts_enforce_row_version() returns trigger language plpgsql as $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)', old.row_version, new.row_version using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end; $function$;

create or replace function public.briefs_enforce_row_version() returns trigger language plpgsql as $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)', old.row_version, new.row_version using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end; $function$;

create or replace function public.enforce_row_version_increment() returns trigger language plpgsql as $function$
begin
  if new.row_version is distinct from old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (expected %, got %)', old.row_version + 1, new.row_version using errcode = 'P0001';
  end if;
  return new;
end; $function$;

create or replace function public._test_accounts_purge() returns jsonb language plpgsql security definer set search_path to '' as $function$
DECLARE r record; v_ws int := 0; v_users int := 0;
BEGIN
  FOR r IN SELECT id FROM auth.users
            WHERE raw_app_meta_data ->> 'test_account' = 'true'
              AND created_at < now() - interval '24 hours' LOOP
    WITH soft AS (
      UPDATE public.workspaces SET deleted_at = now(), row_version = row_version + 1
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
