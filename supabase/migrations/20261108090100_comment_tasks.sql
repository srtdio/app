alter table public.comments add column if not exists task_state text check (task_state in ('assigned','done'));
create table if not exists public.comment_tasks (
  comment_id uuid primary key references public.comments(id) on delete cascade,
  task_id uuid not null unique references public.chat_tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id text not null references public.chat_channels(channel_id) on delete cascade,
  assignee_user_id uuid references auth.users(id) on delete set null,
  group_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now());
create index if not exists comment_tasks_channel_id_idx on public.comment_tasks(channel_id);
create index if not exists comment_tasks_workspace_id_idx on public.comment_tasks(workspace_id);
alter table public.comment_tasks enable row level security;
revoke all on public.comment_tasks from anon, authenticated;
grant select on public.comment_tasks to authenticated;
drop policy if exists comment_tasks_select_agency on public.comment_tasks;
create policy comment_tasks_select_agency on public.comment_tasks for select to authenticated
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = comment_tasks.workspace_id
    and wm.user_id = (select auth.uid()) and wm.active and wm.role = any (array['owner','admin','agency'])));
create or replace function public.comment_task_sync() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.deleted_at is not null then
    update public.comments c set task_state = null from public.comment_tasks l where l.task_id = new.id and c.id = l.comment_id;
    delete from public.comment_tasks where task_id = new.id;
  elsif new.status is distinct from old.status then
    update public.comments c set task_state = case when new.status = 'done' then 'done' else 'assigned' end
      from public.comment_tasks l where l.task_id = new.id and c.id = l.comment_id;
  end if;
  return new;
end $$;
revoke all on function public.comment_task_sync() from public, anon, authenticated;
drop trigger if exists chat_tasks_comment_sync on public.chat_tasks;
create trigger chat_tasks_comment_sync after update of status, deleted_at on public.chat_tasks for each row execute function public.comment_task_sync();
create or replace function public.comment_task_create(p_comment_id uuid, p_channel_id text, p_title text, p_priority smallint, p_due_on date, p_trace_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_c public.comments; v_ch public.chat_channels; v_res jsonb; v_task uuid; v_assignee uuid; v_group text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_trace_id is null then raise exception 'trace_id required'; end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  select * into v_c from public.comments where id = p_comment_id and deleted_at is null for update;
  if v_c.id is null or v_c.entity_type not in ('post','brief') then raise exception 'comment not found'; end if;
  if not exists (select 1 from public.workspace_members wm where wm.workspace_id = v_c.workspace_id and wm.user_id = v_actor
      and wm.active and wm.role = any (array['owner','admin','agency'])) then raise exception 'not allowed'; end if;
  select * into v_ch from public.chat_channels where channel_id = p_channel_id;
  if v_ch.channel_id is null or v_ch.workspace_id <> v_c.workspace_id then raise exception 'chat not found'; end if;
  if exists (select 1 from public.comment_tasks where comment_id = p_comment_id) then raise exception 'task_exists'; end if;
  v_res := public.chat_task_save_batch(p_channel_id, jsonb_build_object('creates', jsonb_build_array(jsonb_build_object(
    'title', p_title, 'side', 'agency', 'priority', coalesce(p_priority, 1), 'due_on', p_due_on))), p_trace_id);
  v_task := (v_res->'created_ids'->>0)::uuid;
  if v_task is null then raise exception 'task not created'; end if;
  if v_ch.channel_type = 'dm' then v_assignee := case when v_ch.dm_user_a = v_actor then v_ch.dm_user_b else v_ch.dm_user_a end;
  elsif v_ch.channel_type = 'notes' then v_assignee := v_actor;
  elsif v_ch.channel_type = 'group' then select g.name into v_group from public.groups g where g.id = v_ch.entity_id;
  end if;
  insert into public.comment_tasks (comment_id, task_id, workspace_id, channel_id, assignee_user_id, group_name, created_by)
  values (p_comment_id, v_task, v_c.workspace_id, p_channel_id, v_assignee, v_group, v_actor);
  update public.comments set task_state = 'assigned' where id = p_comment_id;
  return jsonb_build_object('task_id', v_task, 'batch_id', v_res->'batch_id');
end $$;
revoke all on function public.comment_task_create(uuid,text,text,smallint,date,uuid) from public, anon;
grant execute on function public.comment_task_create(uuid,text,text,smallint,date,uuid) to authenticated;
