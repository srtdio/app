-- Chat: Postgres is the record. Applied to live 2026-09-22 via MCP. Idempotent for CI.
ALTER TABLE public.chat_messages ALTER COLUMN agora_event_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.chat_channel_member(p_channel_id text, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_channels c
    JOIN public.workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = p_user_id AND wm.active = true
    WHERE c.channel_id = p_channel_id
      AND (
        (c.channel_type = 'dm' AND p_user_id IN (c.dm_user_a, c.dm_user_b))
        OR (c.channel_type = 'group' AND EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = c.entity_id AND gm.user_id = p_user_id))
        OR (c.channel_type = 'plan_period')
      )
  );
$$;
REVOKE EXECUTE ON FUNCTION public.chat_channel_member(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_channel_member(text, uuid) TO authenticated;

DROP POLICY IF EXISTS chat_messages_select_member ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_select_channel_member ON public.chat_messages;
CREATE POLICY chat_messages_select_channel_member ON public.chat_messages FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND public.chat_channel_member(channel_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.chat_message_send(
  p_id uuid, p_channel_id text, p_trace_id uuid,
  p_body text DEFAULT NULL, p_mentions jsonb DEFAULT NULL, p_attachment_asset_ids uuid[] DEFAULT NULL)
RETURNS public.chat_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_row public.chat_messages;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_id IS NULL OR p_trace_id IS NULL THEN RAISE EXCEPTION 'p_id and p_trace_id are required'; END IF;
  IF coalesce(length(btrim(p_body)), 0) = 0 AND coalesce(cardinality(p_attachment_asset_ids), 0) = 0 THEN
    RAISE EXCEPTION 'message has no body and no attachments';
  END IF;
  IF length(p_body) > 5000 THEN RAISE EXCEPTION 'body exceeds 5000 characters'; END IF;
  PERFORM set_config('app.trace_id', p_trace_id::text, true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_channels WHERE channel_id = p_channel_id;
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  SELECT * INTO v_row FROM public.chat_messages WHERE id = p_id::text LIMIT 1;
  IF FOUND THEN RETURN v_row; END IF;
  INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids, agora_event_id, created_at)
  VALUES (p_id::text, p_channel_id, v_workspace_id, v_actor, p_body, p_mentions, p_attachment_asset_ids, NULL, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[]) TO authenticated;

CREATE TABLE IF NOT EXISTS public.chat_reactions (
  message_id text NOT NULL,
  channel_id text NOT NULL REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
ALTER TABLE public.chat_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_reactions_select_channel_member ON public.chat_reactions;
CREATE POLICY chat_reactions_select_channel_member ON public.chat_reactions FOR SELECT TO authenticated
  USING (public.chat_channel_member(channel_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.chat_reaction_add(p_message_id text, p_channel_id text, p_emoji text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_messages WHERE id = p_message_id AND channel_id = p_channel_id LIMIT 1;
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'message not found'; END IF;
  INSERT INTO public.chat_reactions (message_id, channel_id, workspace_id, user_id, emoji)
  VALUES (p_message_id, p_channel_id, v_workspace_id, v_actor, p_emoji) ON CONFLICT DO NOTHING;
END; $$;
CREATE OR REPLACE FUNCTION public.chat_reaction_remove(p_message_id text, p_channel_id text, p_emoji text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  DELETE FROM public.chat_reactions WHERE message_id = p_message_id AND channel_id = p_channel_id AND user_id = v_actor AND emoji = p_emoji;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_reaction_add(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_reaction_add(text, text, text, uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_reaction_remove(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_reaction_remove(text, text, text, uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.chat_read_cursors (
  channel_id text NOT NULL REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  last_read_message_id text NOT NULL,
  last_read_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
ALTER TABLE public.chat_read_cursors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_read_cursors_select_channel_member ON public.chat_read_cursors;
CREATE POLICY chat_read_cursors_select_channel_member ON public.chat_read_cursors FOR SELECT TO authenticated
  USING (public.chat_channel_member(channel_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.chat_read_cursor_set(p_channel_id text, p_message_id text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid; v_msg_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id, created_at INTO v_workspace_id, v_msg_at FROM public.chat_messages WHERE id = p_message_id AND channel_id = p_channel_id LIMIT 1;
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'message not found'; END IF;
  INSERT INTO public.chat_read_cursors (channel_id, user_id, workspace_id, last_read_message_id, last_read_at)
  VALUES (p_channel_id, v_actor, v_workspace_id, p_message_id, v_msg_at)
  ON CONFLICT (channel_id, user_id) DO UPDATE
    SET last_read_message_id = EXCLUDED.last_read_message_id, last_read_at = EXCLUDED.last_read_at, updated_at = now()
    WHERE EXCLUDED.last_read_at > public.chat_read_cursors.last_read_at;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_read_cursor_set(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_read_cursor_set(text, text, uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.chat_sync_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('member_add','member_remove','group_rename')),
  channel_id text NOT NULL,
  user_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
ALTER TABLE public.chat_sync_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.chat_sync_enqueue_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.chat_sync_events (workspace_id, event_type, channel_id, user_id)
    VALUES (NEW.workspace_id, 'member_add', 'group__' || NEW.workspace_id::text || '__' || NEW.group_id::text, NEW.user_id);
    RETURN NEW;
  ELSE
    INSERT INTO public.chat_sync_events (workspace_id, event_type, channel_id, user_id)
    VALUES (OLD.workspace_id, 'member_remove', 'group__' || OLD.workspace_id::text || '__' || OLD.group_id::text, OLD.user_id);
    RETURN OLD;
  END IF;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_sync_enqueue_member() FROM PUBLIC;
DROP TRIGGER IF EXISTS chat_sync_group_members ON public.group_members;
CREATE TRIGGER chat_sync_group_members AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.chat_sync_enqueue_member();

CREATE OR REPLACE FUNCTION public.chat_sync_enqueue_rename()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO public.chat_sync_events (workspace_id, event_type, channel_id, payload)
    VALUES (NEW.workspace_id, 'group_rename', 'group__' || NEW.workspace_id::text || '__' || NEW.id::text, jsonb_build_object('name', NEW.name));
  END IF;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_sync_enqueue_rename() FROM PUBLIC;
DROP TRIGGER IF EXISTS chat_sync_groups_rename ON public.groups;
CREATE TRIGGER chat_sync_groups_rename AFTER UPDATE OF name ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.chat_sync_enqueue_rename();

CREATE INDEX IF NOT EXISTS chat_messages_channel_created_idx ON public.chat_messages (channel_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS chat_messages_id_idx ON public.chat_messages (id);
CREATE INDEX IF NOT EXISTS chat_reactions_message_idx ON public.chat_reactions (message_id);
CREATE INDEX IF NOT EXISTS chat_sync_events_pending_idx ON public.chat_sync_events (created_at) WHERE processed_at IS NULL;
-- END MIGRATION
