-- Record of objects applied to movnexawfhsyuluspxoc on 8 Nov 2026 (verified).
-- Read back verbatim from the live database (pg_get_functiondef, information_schema).
-- Work chat threads: per-thread read points, Mark unread, and the threads-for-me list.
-- The table is reachable only through the SECURITY DEFINER procs below: no table
-- privileges for anon or authenticated (select-own policy kept for a future grant).

create table if not exists public.chat_thread_reads (
  root_message_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id text not null,
  workspace_id uuid not null,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (root_message_id, user_id)
);

alter table public.chat_thread_reads enable row level security;

create policy chat_thread_reads_own on public.chat_thread_reads
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.chat_thread_reads from anon, authenticated;

create index if not exists chat_thread_reads_user_channel
  on public.chat_thread_reads using btree (user_id, channel_id);

CREATE OR REPLACE FUNCTION public.chat_thread_read_set(p_channel_id text, p_root_id text, p_message_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_at timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id, created_at into v_ws, v_at from public.chat_messages
   where id = p_message_id and channel_id = p_channel_id and (id = p_root_id or thread_root_message_id = p_root_id) limit 1;
  if v_ws is null then raise exception 'message not found'; end if;
  insert into public.chat_thread_reads (root_message_id, user_id, channel_id, workspace_id, last_read_at)
  values (p_root_id, v_actor, p_channel_id, v_ws, v_at)
  on conflict (root_message_id, user_id) do update
    set last_read_at = excluded.last_read_at, updated_at = now()
    where excluded.last_read_at > public.chat_thread_reads.last_read_at;
end $function$;

CREATE OR REPLACE FUNCTION public.chat_thread_mark_unread(p_channel_id text, p_root_id text, p_message_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_at timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id, created_at into v_ws, v_at from public.chat_messages
   where id = p_message_id and channel_id = p_channel_id and thread_root_message_id = p_root_id limit 1;
  if v_ws is null then raise exception 'message not found'; end if;
  insert into public.chat_thread_reads (root_message_id, user_id, channel_id, workspace_id, last_read_at)
  values (p_root_id, v_actor, p_channel_id, v_ws, v_at - interval '1 microsecond')
  on conflict (root_message_id, user_id) do update set last_read_at = excluded.last_read_at, updated_at = now();
end $function$;

CREATE OR REPLACE FUNCTION public.chat_mark_unread(p_channel_id text, p_message_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_at timestamptz; v_prev text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id, created_at into v_ws, v_at from public.chat_messages
   where id = p_message_id and channel_id = p_channel_id and thread_root_message_id is null limit 1;
  if v_ws is null then raise exception 'message not found'; end if;
  select id into v_prev from public.chat_messages
   where channel_id = p_channel_id and created_at < v_at and created_at > v_at - interval '90 days'
   order by created_at desc limit 1;
  insert into public.chat_read_cursors (channel_id, user_id, workspace_id, last_read_message_id, last_read_at, read_at)
  values (p_channel_id, v_actor, v_ws, coalesce(v_prev, p_message_id), v_at - interval '1 microsecond', now())
  on conflict (channel_id, user_id) do update
    set last_read_message_id = excluded.last_read_message_id, last_read_at = excluded.last_read_at, read_at = now(), updated_at = now();
  insert into public.chat_unread_counters (workspace_id, channel_id, user_id, unread, updated_at)
  values (v_ws, p_channel_id, v_actor, 0, now())
  on conflict (channel_id, user_id) do nothing;
  update public.chat_unread_counters u
     set unread = (select count(*)::int from public.chat_messages m
                    where m.channel_id = p_channel_id and m.deleted_at is null
                      and m.created_at > now() - interval '90 days'
                      and m.sender_user_id is distinct from v_actor
                      and m.created_at > v_at - interval '1 microsecond'
                      and m.created_at > public.chat_cleared_at(p_channel_id, v_actor)),
         updated_at = now()
   where u.channel_id = p_channel_id and u.user_id = v_actor;
end $function$;

CREATE OR REPLACE FUNCTION public.chat_threads_for_me(p_channel_id text, p_trace_id uuid)
 RETURNS TABLE(root_message_id text, reply_count bigint, last_reply_at timestamp with time zone, last_reply_id text, last_reply_sender uuid, last_reply_body text, unread boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_small boolean;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select count(*) <= 6 into v_small from public.workspace_members wm
   where wm.active = true and public.chat_channel_member(p_channel_id, wm.user_id);
  return query
  with r as (
    select m.thread_root_message_id as root_id, count(*) as n, max(m.created_at) as last_at
      from public.chat_messages m
     where m.channel_id = p_channel_id and m.thread_root_message_id is not null
       and m.deleted_at is null and m.created_at > now() - interval '90 days'
     group by m.thread_root_message_id
  ), last as (
    select distinct on (m.thread_root_message_id) m.thread_root_message_id as root_id, m.id, m.sender_user_id, left(m.body, 140) as body
      from public.chat_messages m
     where m.channel_id = p_channel_id and m.thread_root_message_id is not null
       and m.deleted_at is null and m.created_at > now() - interval '90 days'
     order by m.thread_root_message_id, m.created_at desc
  )
  select r.root_id, r.n, r.last_at, l.id, l.sender_user_id, l.body,
         (l.sender_user_id is distinct from v_actor and r.last_at > coalesce(tr.last_read_at, '-infinity'::timestamptz)) as unread
    from r
    join last l on l.root_id = r.root_id
    left join public.chat_messages root on root.id = r.root_id and root.channel_id = p_channel_id
    left join public.chat_thread_reads tr on tr.root_message_id = r.root_id and tr.user_id = v_actor
   where v_small
      or root.sender_user_id = v_actor
      or coalesce(root.mentions, '[]'::jsonb) ? v_actor::text
      or exists (select 1 from public.chat_messages x
                  where x.channel_id = p_channel_id and x.thread_root_message_id = r.root_id
                    and (x.sender_user_id = v_actor or coalesce(x.mentions, '[]'::jsonb) ? v_actor::text))
   order by 7 desc, 3 desc
   limit 50;
end $function$;

revoke all on function public.chat_thread_read_set(text, text, text, uuid) from public, anon;
revoke all on function public.chat_thread_mark_unread(text, text, text, uuid) from public, anon;
revoke all on function public.chat_mark_unread(text, text, uuid) from public, anon;
revoke all on function public.chat_threads_for_me(text, uuid) from public, anon;
grant execute on function public.chat_thread_read_set(text, text, text, uuid) to authenticated;
grant execute on function public.chat_thread_mark_unread(text, text, text, uuid) to authenticated;
grant execute on function public.chat_mark_unread(text, text, uuid) to authenticated;
grant execute on function public.chat_threads_for_me(text, uuid) to authenticated;
