-- Already applied live to movnexawfhsyuluspxoc on 2026-10-25. Records the
-- partition bounds of the two chat read functions (chat_messages is RANGE
-- partitioned by month on created_at).
--
-- 1. chat_thread_reply_counts gains p_since (the earliest root created_at the
--    client sends: a reply is never older than its root) and an upper bound,
--    so the read opens only the months between the oldest root and now. The
--    3-arg version stays until the app no longer calls it (a later cleanup
--    drops it).
-- 2. chat_unread_counts: upper bound inside the lateral subquery (body below
--    is the live pg_get_functiondef, verbatim). Its grants are unchanged.

CREATE OR REPLACE FUNCTION public.chat_thread_reply_counts(p_trace_id uuid, p_channel_id text, p_root_ids text[], p_since timestamptz) RETURNS TABLE(root_id text, reply_count bigint, last_reply_at timestamptz) LANGUAGE sql STABLE SET search_path TO '' AS $function$ select m.thread_root_message_id, count(*), max(m.created_at) from public.chat_messages m where m.channel_id = p_channel_id and m.thread_root_message_id = any (p_root_ids[1:200]) and m.deleted_at is null and m.created_at >= coalesce(p_since, '-infinity'::timestamptz) and m.created_at <= now() + interval '1 minute' group by m.thread_root_message_id $function$;
REVOKE ALL ON FUNCTION public.chat_thread_reply_counts(uuid,text,text[],timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_thread_reply_counts(uuid,text,text[],timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_unread_counts(p_workspace_id uuid)
 RETURNS TABLE(channel_id text, unread bigint, last_message_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT c.channel_id, coalesce(u.unread, 0)::bigint AS unread, lm.last_message_at
  FROM public.chat_channels c
  CROSS JOIN LATERAL (
    SELECT max(m.created_at) AS last_message_at
    FROM public.chat_messages m
    WHERE m.channel_id = c.channel_id
      AND m.workspace_id = p_workspace_id
      AND m.deleted_at IS NULL
      AND m.created_at > now() - interval '90 days'
      AND m.created_at <= now() + interval '1 minute'
  ) lm
  LEFT JOIN public.chat_unread_counters u
    ON u.channel_id = c.channel_id AND u.user_id = (select auth.uid())
  WHERE c.workspace_id = p_workspace_id
    AND lm.last_message_at IS NOT NULL;
$function$;
