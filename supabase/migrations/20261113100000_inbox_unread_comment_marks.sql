-- "New" and "New reply" lines on unread comments (13 Nov 2026): one row per
-- post / brief / plan_item with the caller's unread comment and mention
-- entries, the newest one's comment id, plan id and time (as
-- inbox_unread_entity_targets), plus first_new_at (the oldest unread
-- top-level comment's created_at; null when every unread entry is a reply)
-- and reply_root_ids (the top-level comments whose threads hold an unread
-- reply). Briefs join the mark-read on open. Applied via the Supabase MCP on
-- 13 Nov 2026; inbox_unread_entity_targets stays for the deploy window.
create or replace function public.inbox_unread_comment_marks(p_trace_id uuid, p_workspace_id uuid)
returns table(entity_type text, entity_id text, unread integer, latest_comment_id text, plan_id text, latest_at timestamptz, first_new_at timestamptz, reply_root_ids uuid[])
language sql
stable
set search_path to ''
as $function$
  with e as (
    select e.id, e.entity_type, e.entity_id, e.payload->>'comment_id' as cid, e.payload->>'plan_id' as pid, e.created_at
      from public.inbox_entries e
     where e.workspace_id = p_workspace_id
       and e.user_id = (select auth.uid())
       and e.read_at is null
       and e.deleted_at is null
       and (e.snoozed_until is null or e.snoozed_until <= now())
       and e.entity_id is not null
       and ((e.entity_type in ('post','brief') and e.event_type in ('comment','mention'))
         or (e.entity_type = 'plan_item' and e.event_type in ('plan_comment','mention')))
  ), c as (
    select e.*,
           coalesce(pc.parent_comment_id, pic.parent_comment_id) as parent,
           coalesce(pc.created_at, pic.created_at) as c_at,
           (pc.id is not null or pic.id is not null) as live
      from e
      left join public.comments pc
        on e.entity_type in ('post','brief') and pc.id::text = e.cid and pc.deleted_at is null
      left join public.plan_item_comments pic
        on e.entity_type = 'plan_item' and pic.id::text = e.cid and pic.deleted_at is null
  ), g as (
    select c.entity_type, c.entity_id, count(*)::int as unread,
           min(c.c_at) filter (where c.live and c.parent is null) as first_new_at,
           coalesce(array_agg(distinct c.parent) filter (where c.live and c.parent is not null), '{}'::uuid[]) as reply_root_ids
      from c
     group by c.entity_type, c.entity_id
  )
  select g.entity_type, g.entity_id, g.unread, l.cid, l.pid, l.created_at, g.first_new_at, g.reply_root_ids
    from g
    cross join lateral (
      select c.cid, c.pid, c.created_at
        from c
       where c.entity_type = g.entity_type and c.entity_id = g.entity_id
       order by c.created_at desc, c.id desc
       limit 1
    ) l;
$function$;
revoke all on function public.inbox_unread_comment_marks(uuid, uuid) from public, anon;
grant execute on function public.inbox_unread_comment_marks(uuid, uuid) to authenticated;

create or replace function public.inbox_mark_entity_read(p_workspace_id uuid, p_entity_type text, p_entity_id text, p_trace_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare v_n int;
begin
  if p_entity_type is null or p_entity_type not in ('post','brief','plan_item') or p_entity_id is null or p_entity_id = '' then
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
     and ((p_entity_type in ('post','brief') and event_type in ('comment','mention'))
       or (p_entity_type = 'plan_item' and event_type in ('plan_comment','mention')));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit_log_write('inbox_mark_entity_read','success',p_trace_id,p_workspace_id,p_entity_type,p_entity_id,jsonb_build_object('count',v_n));
  end if;
end; $function$;
