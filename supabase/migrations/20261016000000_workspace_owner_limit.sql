-- Workspace rules: one active workspace per owner on the free plan.
-- Schema already applied via MCP (project movnexawfhsyuluspxoc). Recorded for
-- parity only; idempotent. Exempt owners are active platform_operators rows
-- (live data, not seeded here).
create or replace function public.workspaces_enforce_owner_limit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workspace_owner:'||new.owner_user_id::text, 0));
  if exists (select 1 from platform_operators where user_id = new.owner_user_id and revoked_at is null) then return new; end if;
  if exists (select 1 from workspaces where owner_user_id = new.owner_user_id and deleted_at is null and id <> new.id) then
    raise exception 'workspace_limit_reached' using hint = 'free_plan_one_workspace';
  end if;
  return new;
end $$;
revoke all on function public.workspaces_enforce_owner_limit() from public, anon, authenticated;
drop trigger if exists workspaces_owner_limit on public.workspaces;
create trigger workspaces_owner_limit before insert or update of owner_user_id on public.workspaces for each row execute function public.workspaces_enforce_owner_limit();
