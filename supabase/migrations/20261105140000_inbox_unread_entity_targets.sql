-- Jump to the newest unread comment: one row per post / plan_item with the
-- caller's unread comment entries, plus the newest one's comment id, plan id
-- and time. Same filters as inbox_unread_entity_counts (which stays for the
-- deploy window; the client now reads this one). Applied via the Supabase MCP
-- on 5 Nov 2026.
create function public.inbox_unread_entity_targets(p_trace_id uuid, p_workspace_id uuid)
returns table(entity_type text, entity_id text, unread integer, latest_comment_id text, plan_id text, latest_at timestamptz)
language sql
stable
set search_path to ''
as $function$
  select distinct on (e.entity_type, e.entity_id)
         e.entity_type,
         e.entity_id,
         (count(*) over (partition by e.entity_type, e.entity_id))::int,
         e.payload->>'comment_id',
         e.payload->>'plan_id',
         e.created_at
    from public.inbox_entries e
   where e.workspace_id = p_workspace_id
     and e.user_id = (select auth.uid())
     and e.read_at is null
     and e.deleted_at is null
     and (e.snoozed_until is null or e.snoozed_until <= now())
     and e.entity_id is not null
     and ((e.entity_type = 'post' and e.event_type in ('comment','mention'))
       or (e.entity_type = 'plan_item' and e.event_type in ('plan_comment','mention')))
   order by e.entity_type, e.entity_id, e.created_at desc, e.id desc;
$function$;
revoke all on function public.inbox_unread_entity_targets(uuid, uuid) from public, anon;
grant execute on function public.inbox_unread_entity_targets(uuid, uuid) to authenticated;
