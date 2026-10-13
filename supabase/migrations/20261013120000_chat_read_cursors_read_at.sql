-- chat_read_cursors.read_at: wall-clock time the user advanced their read cursor.
-- Recorded from live (movnexawfhsyuluspxoc). Idempotent. Grants unchanged
-- (REVOKE PUBLIC / GRANT authenticated set in 20260922200000_chat_postgres_record.sql).

alter table public.chat_read_cursors add column if not exists read_at timestamptz;

update public.chat_read_cursors set read_at = updated_at where read_at is null;

CREATE OR REPLACE FUNCTION public.chat_read_cursor_set(p_channel_id text, p_message_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid; v_msg_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id, created_at INTO v_workspace_id, v_msg_at FROM public.chat_messages WHERE id = p_message_id AND channel_id = p_channel_id LIMIT 1;
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'message not found'; END IF;
  INSERT INTO public.chat_read_cursors (channel_id, user_id, workspace_id, last_read_message_id, last_read_at, read_at)
  VALUES (p_channel_id, v_actor, v_workspace_id, p_message_id, v_msg_at, now())
  ON CONFLICT (channel_id, user_id) DO UPDATE
    SET last_read_message_id = EXCLUDED.last_read_message_id, last_read_at = EXCLUDED.last_read_at, read_at = now(), updated_at = now()
    WHERE EXCLUDED.last_read_at > public.chat_read_cursors.last_read_at;
END; $function$;
