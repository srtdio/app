-- Record only: already applied live via MCP (project movnexawfhsyuluspxoc) on 5 Nov 2026. Do not execute.
-- Unread comment markers for Pipeline cards, Plan rows and the Plan nav badge.
--  a) inbox_unread_entity_counts: the caller's unread comment + mention entries
--     per post and per plan item (Activity's own rows, so one source of truth).
--     Snoozed rows count once their snooze has run out, as Activity does.
--  b) inbox_mark_entity_read: opening a post or a plan item marks that entity's
--     unread comment + mention entries read for the caller. The existing
--     inbox_entries_badge_upd trigger lowers the Activity badge.

create or replace function public.inbox_unread_entity_counts(p_trace_id uuid, p_workspace_id uuid)
returns table(entity_type text, entity_id text, unread integer)
language sql
stable
set search_path to ''
as $function$
  select e.entity_type, e.entity_id, count(*)::int
    from public.inbox_entries e
   where e.workspace_id = p_workspace_id
     and e.user_id = (select auth.uid())
     and e.read_at is null
     and e.deleted_at is null
     and (e.snoozed_until is null or e.snoozed_until <= now())
     and e.entity_id is not null
     and ((e.entity_type = 'post' and e.event_type in ('comment','mention'))
       or (e.entity_type = 'plan_item' and e.event_type in ('plan_comment','mention')))
   group by e.entity_type, e.entity_id;
$function$;

create or replace function public.inbox_mark_entity_read(p_workspace_id uuid, p_entity_type text, p_entity_id text, p_trace_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare v_n int;
begin
  if p_entity_type is null or p_entity_type not in ('post','plan_item') or p_entity_id is null or p_entity_id = '' then
    raise exception 'invalid_payload';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'workspace_member_only';
  end if;
  update public.inbox_entries
     set read_at = now()
   where workspace_id = p_workspace_id
     and user_id = auth.uid()
     and entity_type = p_entity_type
     and entity_id = p_entity_id
     and read_at is null
     and deleted_at is null
     and (snoozed_until is null or snoozed_until <= now())
     and ((p_entity_type = 'post' and event_type in ('comment','mention'))
       or (p_entity_type = 'plan_item' and event_type in ('plan_comment','mention')));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit_log_write('inbox_mark_entity_read','success',p_trace_id,p_workspace_id,p_entity_type,p_entity_id,jsonb_build_object('count',v_n));
  end if;
end; $function$;

revoke all on function public.inbox_unread_entity_counts(uuid, uuid) from public, anon;
grant execute on function public.inbox_unread_entity_counts(uuid, uuid) to authenticated;
revoke all on function public.inbox_mark_entity_read(uuid, text, text, uuid) from public, anon;
grant execute on function public.inbox_mark_entity_read(uuid, text, text, uuid) to authenticated;
