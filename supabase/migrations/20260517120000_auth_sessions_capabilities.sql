-- ============================================================
-- Block: Auth + Sessions + Capabilities
-- Tables: session_devices, platform_operators
-- Index/policy adds for: workspace_role_permissions
-- Helpers: public.workspace_id(), public.has_capability()
-- Trigger: workspaces_seed_role_defaults
-- Note: workspace_id() lives in public schema (not auth) due to
-- Supabase MCP permissions on the auth schema.
-- Note: brief.create is client-only per PRD §10.
-- ============================================================

-- session_devices
create table public.session_devices (
  id uuid primary key default uuidv7(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint_hash text not null,
  user_agent text null,
  ip_subnet inet null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create index session_devices_user_id_idx
  on public.session_devices (user_id)
  where revoked_at is null;

create index session_devices_fingerprint_idx
  on public.session_devices (user_id, fingerprint_hash)
  where revoked_at is null;

alter table public.session_devices enable row level security;

create policy session_devices_select_own
  on public.session_devices for select to authenticated
  using (user_id = auth.uid());

create policy session_devices_update_own
  on public.session_devices for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke insert on public.session_devices from authenticated;
revoke delete on public.session_devices from authenticated;

-- platform_operators
create table public.platform_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid null references auth.users(id),
  revoked_at timestamptz null,
  passkey_credential_id text null
);

alter table public.platform_operators enable row level security;

create policy platform_operators_select_self
  on public.platform_operators for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete on public.platform_operators from authenticated;

-- workspace_role_permissions: index + policy + revokes
create index if not exists workspace_role_permissions_lookup_idx
  on public.workspace_role_permissions (workspace_id, role)
  where allowed = true;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'workspace_role_permissions'
      and policyname = 'workspace_role_permissions_select_member'
  ) then
    create policy workspace_role_permissions_select_member
      on public.workspace_role_permissions for select to authenticated
      using (
        exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = workspace_role_permissions.workspace_id
            and wm.user_id = auth.uid()
            and wm.active = true
        )
      );
  end if;
end$$;

revoke insert, update, delete on public.workspace_role_permissions from authenticated;

-- public.workspace_id() helper
create or replace function public.workspace_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'workspace_id',
    ''
  )::uuid;
$$;

revoke execute on function public.workspace_id() from public;
grant execute on function public.workspace_id() to authenticated;

-- public.has_capability() helper
create or replace function public.has_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select wrp.allowed
      from public.workspace_role_permissions wrp
      join public.workspace_members wm
        on wm.workspace_id = wrp.workspace_id
       and wm.role = wrp.role
      where wm.user_id = auth.uid()
        and wm.workspace_id = public.workspace_id()
        and wm.active = true
        and wrp.capability = p_capability
      limit 1
    ),
    false
  );
$$;

revoke execute on function public.has_capability(text) from public;
grant execute on function public.has_capability(text) to authenticated;

-- Seed role defaults on workspace insert (PRD §3, §10)
-- brief.create is client-only by design.
create or replace function public.seed_workspace_role_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'owner', 'workspace.manage_billing', true),
    (new.id, 'owner', 'workspace.delete', true),
    (new.id, 'owner', 'workspace.transfer_ownership', true),
    (new.id, 'owner', 'workspace.manage_members', true),
    (new.id, 'owner', 'workspace.manage_settings', true),
    (new.id, 'owner', 'pipeline.view_all_stages', true),
    (new.id, 'owner', 'pipeline.bulk_actions', true),
    (new.id, 'owner', 'post.create', true),
    (new.id, 'owner', 'post.edit', true),
    (new.id, 'owner', 'post.approve', true),
    (new.id, 'owner', 'post.publish', true),
    (new.id, 'owner', 'brief.view_all', true),
    (new.id, 'owner', 'brief.close', true),
    (new.id, 'owner', 'asset.upload', true),
    (new.id, 'owner', 'asset.delete', true),
    (new.id, 'owner', 'insights.view_full', true),
    (new.id, 'owner', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'admin', 'workspace.manage_members', true),
    (new.id, 'admin', 'workspace.manage_settings', true),
    (new.id, 'admin', 'pipeline.view_all_stages', true),
    (new.id, 'admin', 'pipeline.bulk_actions', true),
    (new.id, 'admin', 'post.create', true),
    (new.id, 'admin', 'post.edit', true),
    (new.id, 'admin', 'post.approve', true),
    (new.id, 'admin', 'post.publish', true),
    (new.id, 'admin', 'brief.view_all', true),
    (new.id, 'admin', 'brief.close', true),
    (new.id, 'admin', 'asset.upload', true),
    (new.id, 'admin', 'asset.delete', true),
    (new.id, 'admin', 'insights.view_full', true),
    (new.id, 'admin', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'agency', 'pipeline.view_all_stages', true),
    (new.id, 'agency', 'pipeline.bulk_actions', true),
    (new.id, 'agency', 'post.create', true),
    (new.id, 'agency', 'post.edit', true),
    (new.id, 'agency', 'post.approve', true),
    (new.id, 'agency', 'post.publish', true),
    (new.id, 'agency', 'brief.view_all', true),
    (new.id, 'agency', 'brief.close', true),
    (new.id, 'agency', 'asset.upload', true),
    (new.id, 'agency', 'asset.delete', true),
    (new.id, 'agency', 'insights.view_full', true),
    (new.id, 'agency', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'client', 'pipeline.view_non_draft', true),
    (new.id, 'client', 'post.approve', true),
    (new.id, 'client', 'brief.view_own', true),
    (new.id, 'client', 'brief.create', true),
    (new.id, 'client', 'brief.close_own', true),
    (new.id, 'client', 'asset.upload', true),
    (new.id, 'client', 'insights.view_curated', true),
    (new.id, 'client', 'inbox.view', true);

  return new;
end;
$$;

revoke execute on function public.seed_workspace_role_defaults() from public;

create trigger workspaces_seed_role_defaults
  after insert on public.workspaces
  for each row
  execute function public.seed_workspace_role_defaults();
