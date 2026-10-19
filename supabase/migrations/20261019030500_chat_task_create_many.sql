-- X4 Tasks: add several, then one Save. Record migration: already applied to
-- v2 (movnexawfhsyuluspxoc); the body is copied from pg_get_functiondef.
-- One call inserts 1-50 tasks (each with its 'created' event) and writes ONE
-- inbox_entries row per other member: event_type 'task_changed', payload
-- {kind:'created_many', count, task_ids, title (last task)}.

CREATE OR REPLACE FUNCTION public.chat_task_create_many(p_channel_id text, p_tasks jsonb, p_trace_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_n int; v_t jsonb; v_task public.chat_tasks;
        v_ids uuid[] := '{}'; v_scope text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text,''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  if jsonb_typeof(p_tasks) <> 'array' or jsonb_array_length(p_tasks) not between 1 and 50 then raise exception 'invalid_payload'; end if;
  select workspace_id, case when channel_type='group' then 'groups' else 'people' end into v_ws, v_scope
    from public.chat_channels where channel_id = p_channel_id;
  insert into public.chat_task_counters (channel_id) values (p_channel_id) on conflict do nothing;
  for v_t in select * from jsonb_array_elements(p_tasks) loop
    update public.chat_task_counters set next_number = next_number + 1 where channel_id = p_channel_id returning next_number - 1 into v_n;
    insert into public.chat_tasks (channel_id, workspace_id, number, title, note, side, priority, due_at, due_set_by, due_set_at, created_by)
    values (p_channel_id, v_ws, v_n, btrim(v_t->>'title'), nullif(btrim(v_t->>'note'),''), v_t->>'side',
            coalesce((v_t->>'priority')::smallint, 2), (v_t->>'due_at')::timestamptz,
            case when v_t->>'due_at' is null then null else v_actor end,
            case when v_t->>'due_at' is null then null else now() end, v_actor)
    returning * into v_task;
    insert into public.chat_task_events (task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value)
    values (v_task.id, p_channel_id, v_ws, v_actor, 'created', null, v_task.title);
    v_ids := v_ids || v_task.id;
  end loop;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select m, v_ws, 'task_changed', 'chat_channel', p_channel_id, v_scope, p_channel_id, 'active',
         jsonb_build_object('kind','created_many','count',cardinality(v_ids),'task_ids',to_jsonb(v_ids),'title',v_task.title), v_actor
    from public.chat_channel_member_ids(p_channel_id) m where m <> v_actor;
  return v_ids;
end $function$;

revoke all on function public.chat_task_create_many(text,jsonb,uuid) from public, anon;
grant execute on function public.chat_task_create_many(text,jsonb,uuid) to authenticated;
