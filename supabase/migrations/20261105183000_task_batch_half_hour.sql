-- Tasks save themselves (no Save button, PR "Plan: no Edit mode, every change
-- saves itself"), so one person's saves in a chat within half an hour of their
-- first share one batch id: one "edited tasks" chat line and one task_changed
-- alert per member. A later save in the window grows the alert in place (counts
-- and task ids merged, read_at back to null); inbox_entries_push_ins fires on
-- insert only, so there is no second push. After half an hour a new batch starts.
-- Same signature and grants. Applied live via Supabase MCP on movnexawfhsyuluspxoc.

create or replace function public.chat_task_save_batch(p_channel_id text, p_batch jsonb, p_trace_id uuid)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_scope text; v_batch uuid := public.uuidv7();
  v_e jsonb; v_c jsonb; v_task public.chat_tasks; v_n int; v_old jsonb; v_new jsonb; v_base timestamptz;
  v_created uuid[] := '{}'; v_touched uuid[] := '{}'; v_conflicts jsonb := '[]'::jsonb;
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
  -- One person's saves in a chat within half an hour of their first are one batch:
  -- one chat line and one alert (20261105183000_task_batch_half_hour).
  perform pg_advisory_xact_lock(hashtextextended('task_batch:' || p_channel_id || ':' || v_actor::text, 0));
  select coalesce((
    select e.batch_id from public.chat_task_events e
     where e.channel_id = p_channel_id and e.actor_user_id = v_actor and e.batch_id is not null
     group by e.batch_id
    having min(e.created_at) > now() - interval '30 minutes'
     order by max(e.created_at) desc limit 1), v_batch) into v_batch;
  perform 1 from public.chat_tasks t
   where t.channel_id = p_channel_id and t.deleted_at is null and t.id in (
     select (x->>'task_id')::uuid from jsonb_array_elements(coalesce(p_batch->'edits','[]'::jsonb)) x
     union select (x->>'task_id')::uuid from jsonb_array_elements(coalesce(p_batch->'deletes','[]'::jsonb)) x)
   order by t.id for update;
  for v_e in select * from jsonb_array_elements(coalesce(p_batch->'edits','[]'::jsonb)) loop
    select * into v_task from public.chat_tasks where id = (v_e->>'task_id')::uuid and channel_id = p_channel_id;
    if v_task.id is null then raise exception 'task not found'; end if;
    v_base := (v_e->>'base_updated_at')::timestamptz;
    if v_base is null then raise exception 'base_updated_at required'; end if;
    if v_task.deleted_at is not null or v_task.updated_at > v_base then
      v_conflicts := v_conflicts || jsonb_build_object('task_id', v_task.id, 'deleted', v_task.deleted_at is not null,
        'title', v_task.title, 'priority', v_task.priority, 'status', v_task.status, 'due_on', v_task.due_on, 'updated_at', v_task.updated_at);
      continue;
    end if;
    v_c := v_e->'changes'; v_old := '{}'; v_new := '{}';
    if v_c is null or jsonb_typeof(v_c) <> 'object' or exists (select 1 from jsonb_object_keys(v_c) k where k not in ('title','priority','status','due_on')) then raise exception 'unknown field'; end if;
    if v_c ? 'title' and btrim(v_c->>'title') is distinct from v_task.title then
      v_old := v_old || jsonb_build_object('title', v_task.title); v_new := v_new || jsonb_build_object('title', btrim(v_c->>'title')); end if;
    if v_c ? 'priority' and (v_c->>'priority')::smallint is distinct from v_task.priority then
      v_old := v_old || jsonb_build_object('priority', v_task.priority); v_new := v_new || jsonb_build_object('priority', (v_c->>'priority')::smallint); end if;
    if v_c ? 'status' and v_c->>'status' is distinct from v_task.status then
      v_old := v_old || jsonb_build_object('status', v_task.status); v_new := v_new || jsonb_build_object('status', v_c->>'status'); end if;
    if v_c ? 'due_on' and (v_c->>'due_on')::date is distinct from v_task.due_on then
      v_old := v_old || jsonb_build_object('due_on', v_task.due_on); v_new := v_new || jsonb_build_object('due_on', (v_c->>'due_on')::date); end if;
    if v_new = '{}'::jsonb then continue; end if;
    update public.chat_tasks set
      title = case when v_new ? 'title' then v_new->>'title' else title end,
      priority = case when v_new ? 'priority' then (v_new->>'priority')::smallint else priority end,
      status = case when v_new ? 'status' then v_new->>'status' else status end,
      due_on = case when v_new ? 'due_on' then (v_new->>'due_on')::date else due_on end,
      done_at = case when v_new ? 'status' then (case when v_new->>'status' = 'done' then clock_timestamp() else null end) else done_at end,
      updated_at = clock_timestamp()
     where id = v_task.id returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, batch_id)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'edited', v_old::text, v_new::text, v_batch);
    v_touched := v_touched || v_task.id;
  end loop;
  for v_e in select * from jsonb_array_elements(coalesce(p_batch->'deletes','[]'::jsonb)) loop
    select * into v_task from public.chat_tasks where id = (v_e->>'task_id')::uuid and channel_id = p_channel_id;
    if v_task.id is null then raise exception 'task not found'; end if;
    v_base := (v_e->>'base_updated_at')::timestamptz;
    if v_base is null then raise exception 'base_updated_at required'; end if;
    if v_task.deleted_at is not null then continue; end if;
    if v_task.updated_at > v_base then
      v_conflicts := v_conflicts || jsonb_build_object('task_id', v_task.id, 'deleted', false,
        'title', v_task.title, 'priority', v_task.priority, 'status', v_task.status, 'due_on', v_task.due_on, 'updated_at', v_task.updated_at);
      continue;
    end if;
    update public.chat_tasks set deleted_at = now(), deleted_by = v_actor, updated_at = clock_timestamp()
     where id = v_task.id returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, batch_id)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'deleted', v_task.title, null, v_batch);
    v_touched := v_touched || v_task.id;
  end loop;
  if jsonb_array_length(coalesce(p_batch->'creates','[]'::jsonb)) > 0 then
    insert into public.chat_task_counters (channel_id) values (p_channel_id) on conflict do nothing;
  end if;
  for v_c in select * from jsonb_array_elements(coalesce(p_batch->'creates','[]'::jsonb)) loop
    update public.chat_task_counters set next_number = next_number + 1 where channel_id = p_channel_id returning next_number - 1 into v_n;
    insert into public.chat_tasks (channel_id, workspace_id, number, title, side, priority, due_on, created_by)
    values (p_channel_id, v_ws, v_n, btrim(v_c->>'title'), v_c->>'side', coalesce((v_c->>'priority')::smallint, 1), nullif(v_c->>'due_on','')::date, v_actor)
    returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, batch_id)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'created', null, v_task.title, v_batch);
    v_created := v_created || v_task.id;
  end loop;
  if cardinality(v_created) + cardinality(v_touched) = 0 then
    return jsonb_build_object('batch_id', null, 'created_ids', '[]'::jsonb, 'conflicts', v_conflicts);
  end if;
  -- The batch's alert grows in place (back to unread, no second push); members
  -- without one get it.
  update public.inbox_entries e
     set payload = jsonb_build_object('kind','batch','batch_id',v_batch,
           'created', u.created, 'changed', greatest(u.n - u.created, 0), 'task_ids', u.ids),
         read_at = null
    from (
      select x.id, coalesce((x.payload->>'created')::int, 0) + cardinality(v_created) as created,
             (select count(distinct t) from (
                select jsonb_array_elements_text(coalesce(x.payload->'task_ids','[]'::jsonb)) t
                union select unnest(v_created || v_touched)::text) s)::int as n,
             (select jsonb_agg(distinct t) from (
                select jsonb_array_elements_text(coalesce(x.payload->'task_ids','[]'::jsonb)) t
                union select unnest(v_created || v_touched)::text) s) as ids
        from public.inbox_entries x
       where x.event_type = 'task_changed' and x.entity_type = 'chat_channel' and x.entity_id = p_channel_id
         and x.payload->>'batch_id' = v_batch::text and x.deleted_at is null) u
   where e.id = u.id;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select m, v_ws, 'task_changed', 'chat_channel', p_channel_id, v_scope, p_channel_id, 'active',
         jsonb_build_object('kind','batch','batch_id',v_batch,'created',cardinality(v_created),'changed',cardinality(v_touched),'task_ids',to_jsonb(v_created || v_touched)), v_actor
    from public.chat_channel_member_ids(p_channel_id) m
   where m <> v_actor
     and not exists (select 1 from public.inbox_entries x
                      where x.user_id = m and x.event_type = 'task_changed' and x.entity_type = 'chat_channel'
                        and x.entity_id = p_channel_id and x.payload->>'batch_id' = v_batch::text and x.deleted_at is null);
  return jsonb_build_object('batch_id', v_batch, 'created_ids', to_jsonb(v_created), 'conflicts', v_conflicts);
end $function$;
revoke all on function public.chat_task_save_batch(text, jsonb, uuid) from public, anon;
grant execute on function public.chat_task_save_batch(text, jsonb, uuid) to authenticated;
