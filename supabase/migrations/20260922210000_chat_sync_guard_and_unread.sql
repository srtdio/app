-- Chat: guard sync trigger during cascades; unread counts read function. Applied to live 2026-09-22 via MCP.
CREATE OR REPLACE FUNCTION public.chat_sync_enqueue_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid; v_channel text; v_user uuid; v_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_ws := NEW.workspace_id; v_user := NEW.user_id; v_type := 'member_add';
    v_channel := 'group__' || NEW.workspace_id::text || '__' || NEW.group_id::text;
  ELSE
    v_ws := OLD.workspace_id; v_user := OLD.user_id; v_type := 'member_remove';
    v_channel := 'group__' || OLD.workspace_id::text || '__' || OLD.group_id::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = v_ws)
     AND EXISTS (SELECT 1 FROM public.chat_channels c WHERE c.channel_id = v_channel) THEN
    INSERT INTO public.chat_sync_events (workspace_id, event_type, channel_id, user_id)
    VALUES (v_ws, v_type, v_channel, v_user);
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; ELSE RETURN OLD; END IF;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_sync_enqueue_member() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.chat_unread_counts(p_workspace_id uuid)
RETURNS TABLE (channel_id text, unread bigint, last_message_at timestamptz)
LANGUAGE sql STABLE SET search_path TO '' AS $$
  SELECT m.channel_id,
         count(*) FILTER (WHERE m.sender_user_id IS DISTINCT FROM auth.uid()
                            AND (c.last_read_at IS NULL OR m.created_at > c.last_read_at)) AS unread,
         max(m.created_at) AS last_message_at
  FROM public.chat_messages m
  LEFT JOIN public.chat_read_cursors c ON c.channel_id = m.channel_id AND c.user_id = auth.uid()
  WHERE m.workspace_id = p_workspace_id
    AND m.deleted_at IS NULL
    AND m.created_at > now() - interval '90 days'
  GROUP BY m.channel_id;
$$;
REVOKE EXECUTE ON FUNCTION public.chat_unread_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts(uuid) TO authenticated;
-- END MIGRATION
