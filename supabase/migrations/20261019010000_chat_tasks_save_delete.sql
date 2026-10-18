-- Applied live 19 Oct 2026 via MCP; this file is the record.
-- Chat tasks: batched save (chat_task_save, one 'edited' event per save) and soft delete (chat_task_delete, any chat member).
-- chat_task_set and chat_tasks_fire_due skip deleted tasks. No index changes (chat_tasks_due_idx stays as is).
alter table public.chat_tasks add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table public.chat_task_events drop constraint chat_task_events_kind_check;
alter table public.chat_task_events add constraint chat_task_events_kind_check check (kind in ('created','status','priority','due','side','title','note','due_passed','edited','deleted'));
create or replace function public.chat_task_save(p_task_id uuid, p_changes jsonb, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_task public.chat_tasks; k text;
  v_old jsonb := '{}'; v_new jsonb := '{}'; v_due timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid changes'; end if;
  select * into v_task from public.chat_tasks where id = p_task_id for update;
  if v_task.id is null or v_task.deleted_at is not null then raise exception 'task not found'; end if;
  if not public.chat_channel_member(v_task.channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('status','priority','side','title','note','due') then raise exception 'unknown field'; end if;
  end loop;
  if p_changes ? 'status' and p_changes->>'status' is distinct from v_task.status then
    v_old := v_old || jsonb_build_object('status', v_task.status); v_new := v_new || jsonb_build_object('status', p_changes->>'status'); end if;
  if p_changes ? 'priority' and (p_changes->>'priority')::smallint is distinct from v_task.priority then
    v_old := v_old || jsonb_build_object('priority', v_task.priority); v_new := v_new || jsonb_build_object('priority', (p_changes->>'priority')::smallint); end if;
  if p_changes ? 'side' and p_changes->>'side' is distinct from v_task.side then
    v_old := v_old || jsonb_build_object('side', v_task.side); v_new := v_new || jsonb_build_object('side', p_changes->>'side'); end if;
  if p_changes ? 'title' and btrim(p_changes->>'title') is distinct from v_task.title then
    v_old := v_old || jsonb_build_object('title', v_task.title); v_new := v_new || jsonb_build_object('title', btrim(p_changes->>'title')); end if;
  if p_changes ? 'note' and nullif(btrim(p_changes->>'note'), '') is distinct from v_task.note then
    v_old := v_old || jsonb_build_object('note', v_task.note); v_new := v_new || jsonb_build_object('note', nullif(btrim(p_changes->>'note'), '')); end if;
  if p_changes ? 'due' then
    v_due := nullif(p_changes->>'due', '')::timestamptz;
    if v_due is distinct from v_task.due_at then
      v_old := v_old || jsonb_build_object('due', v_task.due_at); v_new := v_new || jsonb_build_object('due', v_due); end if;
  end if;
  if v_new = '{}'::jsonb then return; end if;
  update public.chat_tasks set
    status   = case when v_new ? 'status'   then v_new->>'status' else status end,
    priority = case when v_new ? 'priority' then (v_new->>'priority')::smallint else priority end,
    side     = case when v_new ? 'side'     then v_new->>'side' else side end,
    title    = case when v_new ? 'title'    then v_new->>'title' else title end,
    note     = case when v_new ? 'note'     then v_new->>'note' else note end,
    due_at        = case when v_new ? 'due' then v_due else due_at end,
    due_set_by    = case when v_new ? 'due' then v_actor else due_set_by end,
    due_set_at    = case when v_new ? 'due' then now() else due_set_at end,
    due_passed_at = case when v_new ? 'due' then null else due_passed_at end,
    updated_at = now()
  where id = p_task_id returning * into v_task;
  perform public.chat_task_event_write(v_task, 'edited', v_old::text, v_new::text, v_actor, 'active');
end $$;
revoke execute on function public.chat_task_save(uuid, jsonb, uuid) from public;
grant execute on function public.chat_task_save(uuid, jsonb, uuid) to authenticated;
create or replace function public.chat_task_delete(p_task_id uuid, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_task public.chat_tasks;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  select * into v_task from public.chat_tasks where id = p_task_id for update;
  if v_task.id is null or v_task.deleted_at is not null then raise exception 'task not found'; end if;
  if not public.chat_channel_member(v_task.channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  update public.chat_tasks set deleted_at = now(), deleted_by = v_actor, updated_at = now()
  where id = p_task_id returning * into v_task;
  perform public.chat_task_event_write(v_task, 'deleted', null, null, v_actor, 'active');
end $$;
revoke execute on function public.chat_task_delete(uuid, uuid) from public;
grant execute on function public.chat_task_delete(uuid, uuid) to authenticated;
create or replace function public.chat_task_set(p_task_id uuid, p_field text, p_value text, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_task public.chat_tasks; v_old text; v_new text; v_due timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  select * into v_task from public.chat_tasks where id = p_task_id for update;
  if v_task.id is null or v_task.deleted_at is not null then raise exception 'task not found'; end if;
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
    where t.due_at <= now() and t.due_passed_at is null and t.deleted_at is null and t.status in ('todo','waiting')
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
