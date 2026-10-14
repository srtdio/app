-- Onboarding: usernames, private onboarding answers, one-step profile save,
-- default chat group per workspace, invitees join it on accept.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 14 Oct 2026; this file records it.
-- Live-only data fix not replayed here: the Inside Edge workspace got its default group the same day.


-- 1. Usernames: one per person, unique across Sorted
alter table public.users add column username text;
alter table public.users add constraint users_username_format
  check (username is null or username ~ '^[a-z0-9._]{3,20}$');
create unique index users_username_unique on public.users (username) where username is not null;

with base as (
  select id, created_at,
    coalesce(nullif(left(trim(both '._' from regexp_replace(regexp_replace(lower(display_name),'[^a-z0-9]+','.','g'),'\.+','.','g')),18),''),'user') as b
  from public.users where deleted_at is null),
ranked as (select *, row_number() over (partition by b order by created_at) rn from base)
update public.users u
set username = case when length(r.b) < 3 then r.b || '.' || r.rn when r.rn = 1 then r.b else r.b || r.rn end
from ranked r where r.id = u.id;

-- 2. Private answers (age range, how they heard). Only the person can read their own row.
create table public.user_private (
  user_id uuid primary key references public.users(id) on delete cascade,
  age_range text check (age_range in ('18-24','25-34','35-44','45-54','55+')),
  heard_from text check (heard_from in ('friend','instagram','linkedin','google','client','other')),
  updated_at timestamptz not null default now()
);
alter table public.user_private enable row level security;
create policy user_private_select_self on public.user_private
  for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete, truncate on public.user_private from authenticated, anon;
revoke select on public.user_private from anon;

-- 3. Live username check
create function public.username_available(p_username text, p_trace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select lower(trim(p_username)) ~ '^[a-z0-9._]{3,20}$'
     and lower(trim(p_username)) <> all (array['admin','support','sorted','srtd','help','team','everyone'])
     and not exists (select 1 from public.users
                     where username = lower(trim(p_username)) and id <> auth.uid());
$$;
revoke all on function public.username_available(text, uuid) from public, anon;
grant execute on function public.username_available(text, uuid) to authenticated;

-- 4. Save the onboarding profile in one step (photo optional)
create function public.user_onboarding_save(p_payload jsonb, p_trace_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := nullif(trim(p_payload->>'display_name'), '');
  v_un text := lower(trim(coalesce(p_payload->>'username', '')));
BEGIN
  IF v_uid IS NULL OR v_name IS NULL OR v_un !~ '^[a-z0-9._]{3,20}$'
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
END; $$;
revoke all on function public.user_onboarding_save(jsonb, uuid) from public, anon;
grant execute on function public.user_onboarding_save(jsonb, uuid) to authenticated;

-- 5. Every new workspace gets its own chat group, owner inside
alter table public.groups add column is_default boolean not null default false;
create unique index groups_one_default_per_workspace
  on public.groups (workspace_id) where is_default and deleted_at is null;

-- workspace_create: identical to live, plus the default-group block before the audit write
CREATE OR REPLACE FUNCTION public.workspace_create(p_payload jsonb, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_id uuid; v_uid uuid := auth.uid(); v_name text; v_timezone text; v_key text;
  v_base text; v_candidate text; i int; v_gname text; v_gid uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  v_name     := p_payload->>'name';
  v_timezone := p_payload->>'timezone';
  IF v_name IS NULL OR v_timezone IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_key := nullif(upper(trim(coalesce(p_payload->>'key',''))),'');
  IF v_key IS NOT NULL THEN
    IF v_key !~ '^[A-Z][A-Z0-9]{1,4}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    IF EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_key) THEN RAISE EXCEPTION 'workspace_key_taken'; END IF;
  ELSE
    SELECT string_agg(left(w,1),'') INTO v_base
      FROM regexp_split_to_table(trim(regexp_replace(upper(v_name),'[^A-Z0-9 ]','','g')),'\s+') AS w WHERE w <> '';
    IF v_base IS NULL OR length(v_base) < 2 THEN v_base := left(regexp_replace(upper(v_name),'[^A-Z0-9]','','g'),4); END IF;
    IF v_base IS NULL OR length(v_base) < 2 OR v_base !~ '^[A-Z]' THEN v_base := 'WS'; END IF;
    v_base := left(v_base,5);
    IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_base) THEN v_key := v_base;
    ELSE
      FOR i IN 2..9 LOOP
        v_candidate := left(v_base,4) || i::text;
        IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_candidate) THEN v_key := v_candidate; EXIT; END IF;
      END LOOP;
    END IF;
    IF v_key IS NULL THEN RAISE EXCEPTION 'workspace_key_taken'; END IF;
  END IF;
  BEGIN
    INSERT INTO public.workspaces (name, owner_user_id, timezone, key)
    VALUES (v_name, v_uid, v_timezone, v_key) RETURNING id INTO v_id;
    INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
    VALUES (v_id, v_uid, 'owner', now());
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'workspace_key_taken';
    WHEN check_violation OR not_null_violation OR invalid_text_representation
      OR foreign_key_violation THEN RAISE EXCEPTION 'invalid_payload';
  END;
  -- Default chat group. Group names allow letters, digits, spaces and hyphens only.
  v_gname := left(trim(regexp_replace(regexp_replace(replace(v_name,'&',' and '),'[^A-Za-z0-9 -]','','g'),'\s+',' ','g')),40);
  IF v_gname = '' THEN v_gname := 'Team'; END IF;
  v_gid := public.group_create(v_id, v_gname, '{}'::uuid[], p_trace_id);
  UPDATE public.groups SET is_default = true WHERE id = v_gid;
  PERFORM public.audit_log_write('workspace_create','success',p_trace_id,v_id,'workspace',v_id::text,
          jsonb_build_object('name',v_name,'timezone',v_timezone,'key',v_key,'default_group_id',v_gid));
  RETURN v_id;
END;
$function$;

-- 6. Invites join the chat group on accept (on by default; the inviter can turn it off)
alter table public.workspace_members add column join_default_group boolean not null default true;

create function public.member_join_group_set(p_member_id uuid, p_join boolean, p_trace_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.workspace_members
   WHERE id = p_member_id AND accepted_at IS NULL AND removed_at IS NULL;
  IF v_ws IS NULL OR p_join IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'workspace.manage_members') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.workspace_members SET join_default_group = p_join WHERE id = p_member_id;
  PERFORM public.audit_log_write('member_join_group_set','success',p_trace_id,v_ws,'workspace_member',
          p_member_id::text, jsonb_build_object('join', p_join));
  RETURN p_member_id;
END; $$;
revoke all on function public.member_join_group_set(uuid, boolean, uuid) from public, anon;
grant execute on function public.member_join_group_set(uuid, boolean, uuid) to authenticated;

-- member_accept: identical to live, plus the group join at the end
CREATE OR REPLACE FUNCTION public.member_accept(p_invite_id uuid, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_user uuid; v_email text; v_join boolean;
BEGIN
  SELECT workspace_id, user_id, join_default_group INTO v_ws, v_user, v_join
    FROM public.workspace_members WHERE id = p_invite_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF v_user IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.workspace_members SET active = true, accepted_at = now()
  WHERE id = p_invite_id AND active = false AND accepted_at IS NULL AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public.audit_log_write('member_accept','success',p_trace_id,v_ws,'workspace_member',p_invite_id::text,NULL);
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user;
  IF v_email IS NOT NULL THEN
    UPDATE public.comments c
    SET author_user_id = v_user, legacy_author_name = NULL, legacy_author_email = NULL
    WHERE c.workspace_id = v_ws AND c.legacy_author_name IS NOT NULL AND c.legacy_author_email = v_email;
  END IF;
  IF v_join THEN
    INSERT INTO public.group_members (group_id, user_id, workspace_id)
    SELECT g.id, v_user, v_ws FROM public.groups g
     WHERE g.workspace_id = v_ws AND g.is_default AND g.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN p_invite_id;
END; $function$;
