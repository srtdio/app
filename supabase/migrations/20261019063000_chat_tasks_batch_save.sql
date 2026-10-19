-- Schema already applied via MCP on 19 Oct 2026. Do NOT execute. Do NOT run supabase db push.
-- Applied live 19 Oct 2026 via MCP on v2 (movnexawfhsyuluspxoc); this file is the record.
-- Chat tasks: one shared list, one Save. Status is todo/done only; due times
-- are no longer fired (the cron job is unscheduled). chat_task_save_batch
-- writes a whole Save (creates, edits, deletes) in one call: its events share
-- one batch_id, and ONE inbox_entries row goes to each other member
-- (event_type 'task_changed', payload {kind:'batch', batch_id, created,
-- changed, task_ids}). Any member of the chat may call it. Every edit and
-- delete carries base_updated_at (the task's updated_at when the caller last
-- synced it); a task changed (or deleted) since is skipped and returned in
-- conflicts [{task_id, deleted, title, priority, status, updated_at}].
-- Returns {batch_id, created_ids, conflicts}.
-- The cron.unschedule call is wrapped in to_regclass('cron.job') like 20261013043000; CI containers have no pg_cron.
-- uuidv7 is public.uuidv7() (search_path is '' inside the function).

-- (a) DESTRUCTIVE: narrows chat_tasks.status to ('todo','done') and rewrites
-- existing rows (approved -> done; waiting, shared, rejected -> todo).
-- Rollback: alter table public.chat_tasks drop constraint chat_tasks_status_check;
--   alter table public.chat_tasks add constraint chat_tasks_status_check
--   check (status in ('todo','waiting','shared','approved','rejected'));
-- (the rewritten rows keep their new values; the old statuses are not restored).
alter table public.chat_tasks drop constraint chat_tasks_status_check;
update public.chat_tasks set status = 'done' where status = 'approved';
update public.chat_tasks set status = 'todo' where status in ('waiting','shared','rejected');
alter table public.chat_tasks add constraint chat_tasks_status_check check (status in ('todo','done'));

-- (b) One Save, one batch.
alter table public.chat_task_events add column if not exists batch_id uuid;
create index if not exists chat_task_events_channel_batch_idx
  on public.chat_task_events (channel_id, batch_id) where batch_id is not null;

create or replace function public.chat_task_save_batch(p_channel_id text, p_batch jsonb, p_trace_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_ws uuid; v_scope text; v_batch uuid := public.uuidv7();
  v_e jsonb; v_c jsonb; v_task public.chat_tasks; v_n int; v_old jsonb; v_new jsonb; v_id uuid;
  v_created uuid[] := '{}'; v_touched uuid[] := '{}';
  v_base timestamptz; v_conflicts jsonb := '[]';
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text,''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  if p_batch is null or jsonb_typeof(p_batch) <> 'object'
     or jsonb_array_length(coalesce(p_batch->'creates','[]'::jsonb)) > 50
     or jsonb_array_length(coalesce(p_batch->'edits','[]'::jsonb)) > 200
     or jsonb_array_length(coalesce(p_batch->'deletes','[]'::jsonb)) > 200 then raise exception 'invalid_payload'; end if;
  select workspace_id, case when channel_type='group' then 'groups' else 'people' end into v_ws, v_scope
    from public.chat_channels where channel_id = p_channel_id;
  perform 1 from public.chat_tasks t
   where t.channel_id = p_channel_id and t.id in (
     select (x->>'task_id')::uuid from jsonb_array_elements(coalesce(p_batch->'edits','[]'::jsonb)) x
     union select (x->>'task_id')::uuid from jsonb_array_elements(coalesce(p_batch->'deletes','[]'::jsonb)) x)
   order by t.id for update;
  for v_e in select * from jsonb_array_elements(coalesce(p_batch->'edits','[]'::jsonb)) loop
    select * into v_task from public.chat_tasks where id = (v_e->>'task_id')::uuid and channel_id = p_channel_id;
    if v_task.id is null then raise exception 'task not found'; end if;
    v_base := (v_e->>'base_updated_at')::timestamptz;
    if v_base is null then raise exception 'base_updated_at required'; end if;
    if v_task.deleted_at is not null or v_task.updated_at > v_base then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'task_id', v_task.id, 'deleted', v_task.deleted_at is not null, 'title', v_task.title,
        'priority', v_task.priority, 'status', v_task.status, 'updated_at', v_task.updated_at));
      continue;
    end if;
    v_c := v_e->'changes'; v_old := '{}'; v_new := '{}';
    if v_c is null or jsonb_typeof(v_c) <> 'object' or exists (select 1 from jsonb_object_keys(v_c) k where k not in ('title','priority','status')) then raise exception 'unknown field'; end if;
    if v_c ? 'title' and btrim(v_c->>'title') is distinct from v_task.title then
      v_old := v_old || jsonb_build_object('title', v_task.title); v_new := v_new || jsonb_build_object('title', btrim(v_c->>'title')); end if;
    if v_c ? 'priority' and (v_c->>'priority')::smallint is distinct from v_task.priority then
      v_old := v_old || jsonb_build_object('priority', v_task.priority); v_new := v_new || jsonb_build_object('priority', (v_c->>'priority')::smallint); end if;
    if v_c ? 'status' and v_c->>'status' is distinct from v_task.status then
      v_old := v_old || jsonb_build_object('status', v_task.status); v_new := v_new || jsonb_build_object('status', v_c->>'status'); end if;
    if v_new = '{}'::jsonb then continue; end if;
    update public.chat_tasks set
      title = case when v_new ? 'title' then v_new->>'title' else title end,
      priority = case when v_new ? 'priority' then (v_new->>'priority')::smallint else priority end,
      status = case when v_new ? 'status' then v_new->>'status' else status end,
      updated_at = clock_timestamp()
     where id = v_task.id returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, batch_id)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'edited', v_old::text, v_new::text, v_batch);
    v_touched := v_touched || v_task.id;
  end loop;
  for v_e in select * from jsonb_array_elements(coalesce(p_batch->'deletes','[]'::jsonb)) loop
    v_id := (v_e->>'task_id')::uuid;
    v_base := (v_e->>'base_updated_at')::timestamptz;
    if v_base is null then raise exception 'base_updated_at required'; end if;
    select * into v_task from public.chat_tasks where id = v_id and channel_id = p_channel_id;
    if v_task.id is null then raise exception 'task not found'; end if;
    if v_task.deleted_at is not null then continue; end if;
    if v_task.updated_at > v_base then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'task_id', v_task.id, 'deleted', false, 'title', v_task.title,
        'priority', v_task.priority, 'status', v_task.status, 'updated_at', v_task.updated_at));
      continue;
    end if;
    update public.chat_tasks set deleted_at = clock_timestamp(), deleted_by = v_actor, updated_at = clock_timestamp()
     where id = v_id returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, batch_id)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'deleted', v_task.title, null, v_batch);
    v_touched := v_touched || v_id;
  end loop;
  if jsonb_array_length(coalesce(p_batch->'creates','[]'::jsonb)) > 0 then
    insert into public.chat_task_counters (channel_id) values (p_channel_id) on conflict do nothing;
  end if;
  for v_c in select * from jsonb_array_elements(coalesce(p_batch->'creates','[]'::jsonb)) loop
    update public.chat_task_counters set next_number = next_number + 1 where channel_id = p_channel_id returning next_number - 1 into v_n;
    insert into public.chat_tasks (channel_id, workspace_id, number, title, side, priority, created_by)
    values (p_channel_id, v_ws, v_n, btrim(v_c->>'title'), v_c->>'side', coalesce((v_c->>'priority')::smallint, 1), v_actor)
    returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, batch_id)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'created', null, v_task.title, v_batch);
    v_created := v_created || v_task.id;
  end loop;
  if cardinality(v_created) + cardinality(v_touched) = 0 then
    return jsonb_build_object('batch_id', null, 'created_ids', '[]'::jsonb, 'conflicts', v_conflicts);
  end if;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select m, v_ws, 'task_changed', 'chat_channel', p_channel_id, v_scope, p_channel_id, 'active',
         jsonb_build_object('kind','batch','batch_id',v_batch,'created',cardinality(v_created),'changed',cardinality(v_touched),'task_ids',to_jsonb(v_created || v_touched)), v_actor
    from public.chat_channel_member_ids(p_channel_id) m where m <> v_actor;
  return jsonb_build_object('batch_id', v_batch, 'created_ids', to_jsonb(v_created), 'conflicts', v_conflicts);
end $$;
revoke all on function public.chat_task_save_batch(text, jsonb, uuid) from public, anon;
grant execute on function public.chat_task_save_batch(text, jsonb, uuid) to authenticated;

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule('chat-tasks-fire-due');
  end if;
end $$;
