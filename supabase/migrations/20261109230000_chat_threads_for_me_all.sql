-- Record of objects applied to movnexawfhsyuluspxoc on 2026-11-09 (verified via pg_get_functiondef). Do NOT run supabase db push.
-- Workspace-wide thread list for the Activity Threads button: every chat thread the caller follows, across channels.
CREATE OR REPLACE FUNCTION public.chat_threads_for_me_all(p_workspace_id uuid, p_trace_id uuid)
 RETURNS TABLE(channel_id text, root_message_id text, reply_count bigint, last_reply_at timestamp with time zone, last_reply_id text, last_reply_sender uuid, last_reply_body text, unread boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = p_workspace_id and wm.user_id = v_actor and wm.active = true)
  then raise exception 'not a member of this workspace'; end if;
  return query
  with ch as materialized (
    select c.channel_id as cid from public.chat_channels c
     where c.workspace_id = p_workspace_id
       and public.chat_channel_member(c.channel_id, v_actor)
       and exists (select 1 from public.chat_messages m
                    where m.channel_id = c.channel_id and m.thread_root_message_id is not null
                      and m.deleted_at is null and m.created_at > now() - interval '90 days')
  )
  select ch.cid, t.root_message_id, t.reply_count, t.last_reply_at,
         t.last_reply_id, t.last_reply_sender, t.last_reply_body, t.unread
    from ch cross join lateral public.chat_threads_for_me(ch.cid, p_trace_id) t
   order by t.unread desc, t.last_reply_at desc
   limit 50;
end $function$;

-- Live ACL: {postgres=X/postgres,authenticated=X/postgres}
REVOKE ALL ON FUNCTION public.chat_threads_for_me_all(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_threads_for_me_all(uuid, uuid) TO authenticated;
