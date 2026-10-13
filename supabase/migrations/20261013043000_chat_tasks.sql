-- Chat task list (applied live 13 Oct 2026 via MCP; this file is the record). Per-chat numbered items, change log, bell fan-out, due timer.
-- The one difference from the applied SQL: the cron.schedule call is wrapped in
-- IF to_regclass('cron.job') IS NOT NULL (same guard as 20261003140000_chat_message_reminders.sql).
-- CI containers have no pg_cron; live has it, so the job is scheduled as applied.
create table public.chat_task_counters (
  channel_id text primary key references public.chat_channels(channel_id) on delete cascade,
  next_number integer not null default 1 check (next_number > 0)
);
create table public.chat_tasks (
  id uuid primary key default public.uuidv7(),
  channel_id text not null references public.chat_channels(channel_id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  number integer not null check (number > 0),
  title text not null check (char_length(title) between 1 and 200),
  note text check (note is null or char_length(note) <= 200),
  side text not null check (side in ('agency','client')),
  status text not null default 'todo' check (status in ('todo','waiting','shared','approved','rejected')),
  priority smallint not null default 2 check (priority in (0,1,2)),
  due_at timestamptz,
  due_set_by uuid references auth.users(id) on delete set null,
  due_set_at timestamptz,
  due_passed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, number)
);
create index chat_tasks_channel_idx on public.chat_tasks (channel_id, status, priority, number);
create index chat_tasks_due_idx on public.chat_tasks (due_at) where due_passed_at is null and status in ('todo','waiting');
create table public.chat_task_events (
  id uuid primary key default public.uuidv7(),
  task_id uuid not null references public.chat_tasks(id) on delete cascade,
  channel_id text not null references public.chat_channels(channel_id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('created','status','priority','due','side','title','note','due_passed')),
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index chat_task_events_channel_idx on public.chat_task_events (channel_id, created_at desc);
create index chat_task_events_task_idx on public.chat_task_events (task_id, created_at desc);
alter table public.chat_task_counters enable row level security;
alter table public.chat_tasks enable row level security;
alter table public.chat_task_events enable row level security;
create policy chat_tasks_select_channel_member on public.chat_tasks for select to authenticated using (public.chat_channel_member(channel_id, auth.uid()));
create policy chat_task_events_select_channel_member on public.chat_task_events for select to authenticated using (public.chat_channel_member(channel_id, auth.uid()));
grant select on public.chat_tasks, public.chat_task_events to authenticated;
alter table public.inbox_entries drop constraint inbox_entries_event_type_check;
alter table public.inbox_entries add constraint inbox_entries_event_type_check check (event_type in (
  'comment','mention','stage_change','comment_resolved','brief_created','brief_closed','asset_uploaded',
  'asset_version_added','invite','trial_warning','billing_failure','system','checkpoints_added','post_ready',
  'checkpoint_reopened','checkpoint_asked','scheduled_sent','scheduled_failed','reminder','post_deleted',
  'assets_deleted','plan_comment','plan_review','plan_opened','plan_deleted','plan_date_changed','plan_updated',
  'task_changed','task_due'));
create or replace function public.chat_channel_member_ids(p_channel_id text)
returns setof uuid language sql stable security definer set search_path to '' as $$
  select wm.user_id
  from public.chat_channels c
  join public.workspace_members wm on wm.workspace_id = c.workspace_id and wm.active = true
  where c.channel_id = p_channel_id
    and ((c.channel_type = 'dm' and wm.user_id in (c.dm_user_a, c.dm_user_b))
      or (c.channel_type = 'group' and exists (select 1 from public.group_members gm where gm.group_id = c.entity_id and gm.user_id = wm.user_id))
      or (c.channel_type = 'notes' and wm.user_id = c.owner_user_id));
$$;
revoke execute on function public.chat_channel_member_ids(text) from public;
create or replace function public.chat_task_event_write(p_task public.chat_tasks, p_kind text, p_old text, p_new text, p_actor uuid, p_tier text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_scope text;
begin
  insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value)
  values (p_task.id, p_task.channel_id, p_task.workspace_id, p_actor, p_kind, p_old, p_new);
  select case when c.channel_type = 'group' then 'groups' else 'people' end into v_scope from public.chat_channels c where c.channel_id = p_task.channel_id;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select m, p_task.workspace_id, case when p_kind = 'due_passed' then 'task_due' else 'task_changed' end,
    'chat_channel', p_task.channel_id, v_scope, p_task.channel_id, p_tier,
    jsonb_build_object('task_id', p_task.id::text, 'number', p_task.number, 'title', p_task.title, 'kind', p_kind, 'old', p_old, 'new', p_new),
    p_actor
  from public.chat_channel_member_ids(p_task.channel_id) m
  where p_actor is null or m <> p_actor;
end $$;
revoke execute on function public.chat_task_event_write(public.chat_tasks, text, text, text, uuid, text) from public;
create or replace function public.chat_task_create(p_channel_id text, p_title text, p_note text, p_side text, p_priority smallint, p_due_at timestamptz, p_trace_id uuid)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_workspace_id uuid; v_number integer; v_task public.chat_tasks;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id into v_workspace_id from public.chat_channels where channel_id = p_channel_id;
  insert into public.chat_task_counters (channel_id) values (p_channel_id) on conflict (channel_id) do nothing;
  update public.chat_task_counters set next_number = next_number + 1 where channel_id = p_channel_id returning next_number - 1 into v_number;
  insert into public.chat_tasks (channel_id, workspace_id, number, title, note, side, priority, due_at, due_set_by, due_set_at, created_by)
  values (p_channel_id, v_workspace_id, v_number, btrim(p_title), nullif(btrim(p_note), ''), p_side, coalesce(p_priority, 2),
          p_due_at, case when p_due_at is null then null else v_actor end, case when p_due_at is null then null else now() end, v_actor)
  returning * into v_task;
  perform public.chat_task_event_write(v_task, 'created', null, v_task.title, v_actor, 'active');
  return v_task.id;
end $$;
revoke execute on function public.chat_task_create(text, text, text, text, smallint, timestamptz, uuid) from public;
grant execute on function public.chat_task_create(text, text, text, text, smallint, timestamptz, uuid) to authenticated;
create or replace function public.chat_task_set(p_task_id uuid, p_field text, p_value text, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_task public.chat_tasks; v_old text; v_new text; v_due timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  select * into v_task from public.chat_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'task not found'; end if;
  if not public.chat_channel_member(v_task.channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  case p_field
    when 'status'   then v_old := v_task.status;         v_new := p_value;
    when 'priority' then v_old := v_task.priority::text; v_new := p_value;
    when 'side'     then v_old := v_task.side;           v_new := p_value;
    when 'title'    then v_old := v_task.title;          v_new := btrim(p_value);
    when 'note'     then v_old := v_task.note;           v_new := nullif(btrim(p_value), '');
    when 'due'      then v_due := nullif(p_value, '')::timestamptz; v_old := v_task.due_at::text; v_new := v_due::text;
    else raise exception 'unknown field';
  end case;
  if v_old is not distinct from v_new then return; end if;
  case p_field
    when 'status'   then update public.chat_tasks set status = v_new, updated_at = now() where id = p_task_id;
    when 'priority' then update public.chat_tasks set priority = v_new::smallint, updated_at = now() where id = p_task_id;
    when 'side'     then update public.chat_tasks set side = v_new, updated_at = now() where id = p_task_id;
    when 'title'    then update public.chat_tasks set title = v_new, updated_at = now() where id = p_task_id;
    when 'note'     then update public.chat_tasks set note = v_new, updated_at = now() where id = p_task_id;
    when 'due'      then update public.chat_tasks set due_at = v_due, due_set_by = v_actor, due_set_at = now(), due_passed_at = null, updated_at = now() where id = p_task_id;
  end case;
  select * into v_task from public.chat_tasks where id = p_task_id;
  perform public.chat_task_event_write(v_task, p_field, v_old, v_new, v_actor, 'active');
end $$;
revoke execute on function public.chat_task_set(uuid, text, text, uuid) from public;
grant execute on function public.chat_task_set(uuid, text, text, uuid) to authenticated;
create or replace function public.chat_tasks_fire_due(p_limit integer default 500)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_count integer := 0; r public.chat_tasks;
begin
  for r in
    select * from public.chat_tasks t
    where t.due_at <= now() and t.due_passed_at is null and t.status in ('todo','waiting')
    order by t.due_at limit least(greatest(coalesce(p_limit, 500), 1), 2000) for update skip locked
  loop
    update public.chat_tasks set due_passed_at = now() where id = r.id;
    r.due_passed_at := now();
    perform public.chat_task_event_write(r, 'due_passed', r.due_at::text, null, null, 'urgent');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function public.chat_tasks_fire_due(integer) from public;
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.schedule('chat-tasks-fire-due', '* * * * *', 'select public.chat_tasks_fire_due(500)');
  end if;
end $$;
