-- Migration: 0001_workspaces_and_members
-- Schema already applied via Supabase MCP. Do NOT execute.
--
-- This file is the repo-history record of the Identity and Workspace tables
-- (sorted-v2-schema §5). It was applied to project movnexawfhsyuluspxoc
-- transactionally via the Supabase MCP before this PR was opened; CI must not
-- re-run it. RLS is enabled with no policies (deny-all interim state); the RLS
-- baseline policies arrive in a later PR.

-- uuidv7 primary-key helper. Postgres 17 has no native uuidv7(); this is the
-- canonical pure-SQL implementation (timestamp-prefixed, version/variant bits
-- set) so PKs are time-ordered per schema doc §1.
create or replace function public.uuidv7()
returns uuid
language sql
volatile
as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(
            int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
            from 3)
          from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$;

-- Optimistic concurrency control (doctrine #4): every UPDATE must advance
-- row_version by exactly 1, otherwise the write is rejected as a serialization
-- failure for the caller to retry.
create or replace function public.enforce_row_version_increment()
returns trigger
language plpgsql
as $$
begin
  if new.row_version is distinct from old.row_version + 1 then
    raise exception
      'row_version must increment by exactly 1 (expected %, got %)',
      old.row_version + 1, new.row_version
      using errcode = 'serialization_failure';
  end if;
  return new;
end;
$$;

-- 1. workspaces: the multi-tenant root. One workspace = one client = one platform.
create table public.workspaces (
  id                            uuid        primary key default public.uuidv7(),
  name                          text        not null check (char_length(name) between 1 and 80),
  owner_user_id                 uuid        not null references auth.users(id),
  plan_tier                     text        not null default 'solo'
                                  check (plan_tier in ('solo', 'studio', 'agency', 'enterprise')),
  timezone                      text        not null,
  week_start_day                smallint    not null default 1 check (week_start_day between 0 and 6),
  stripe_customer_id            text,
  stripe_subscription_id        text,
  subscription_state            text        not null default 'trial'
                                  check (subscription_state in
                                    ('trial', 'active', 'read_only', 'grace',
                                     'soft_pause', 'full_pause', 'soft_delete')),
  subscription_state_expires_at timestamptz,
  trial_ends_at                 timestamptz,
  activated_at                  timestamptz,
  digest_default_time           time        not null default '09:00',
  target_distributions          jsonb,
  row_version                   bigint      not null default 1,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  deleted_at                    timestamptz
);

create trigger workspaces_row_version_occ
  before update on public.workspaces
  for each row execute function public.enforce_row_version_increment();

-- 2. workspace_members: which users belong to a workspace and in what role.
create table public.workspace_members (
  id           uuid        primary key default public.uuidv7(),
  workspace_id uuid        not null references public.workspaces(id) on delete cascade,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  role         text        not null check (role in ('owner', 'admin', 'agency', 'client')),
  active       boolean     not null default true,
  invited_by   uuid        references auth.users(id) on delete set null,
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  removed_at   timestamptz,
  rejoined_at  timestamptz
);

-- A user may hold at most one active membership per workspace; removed/rejoined
-- history rows are kept, so the uniqueness is partial on active = true.
create unique index workspace_members_active_uq
  on public.workspace_members (workspace_id, user_id)
  where active = true;

-- 3. workspace_role_permissions: per-workspace capability grants by role.
create table public.workspace_role_permissions (
  workspace_id uuid        not null references public.workspaces(id) on delete cascade,
  role         text        not null check (role in ('owner', 'admin', 'agency', 'client')),
  capability   text        not null,
  allowed      boolean     not null default true,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, role, capability)
);

-- 4. workspace_settings: one free-form settings document per workspace.
create table public.workspace_settings (
  workspace_id uuid        primary key references public.workspaces(id) on delete cascade,
  payload      jsonb       not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references auth.users(id)
);

-- RLS: enabled on every table. No policies are defined in this migration, so
-- the default is deny-all. Policies arrive in the RLS baseline PR.
alter table public.workspaces                 enable row level security;
alter table public.workspace_members          enable row level security;
alter table public.workspace_role_permissions enable row level security;
alter table public.workspace_settings         enable row level security;
