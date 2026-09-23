-- Chat: shared posts, replies, attachment meta; deactivation reaches Agora. Applied to live 2026-09-23 via MCP.
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS shared_post_ids uuid[];
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS reply_to_message_id text;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS attachment_meta jsonb;

DROP FUNCTION IF EXISTS public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[]);
CREATE OR REPLACE FUNCTION public.chat_message_send(
  p_id uuid, p_channel_id text, p_trace_id uuid,
  p_body text DEFAULT NULL, p_mentions jsonb DEFAULT NULL, p_attachment_asset_ids uuid[] DEFAULT NULL,
  p_shared_post_ids uuid[] DEFAULT NULL, p_reply_to_message_id text DEFAULT NULL, p_attachment_meta jsonb DEFAULT NULL)
RETURNS public.chat_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_row public.chat_messages;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_id IS NULL OR p_trace_id IS NULL THEN RAISE EXCEPTION 'p_id and p_trace_id are required'; END IF;
  IF coalesce(length(btrim(p_body)), 0) = 0
     AND coalesce(cardinality(p_attachment_asset_ids), 0) = 0
     AND coalesce(cardinality(p_shared_post_ids), 0) = 0 THEN
    RAISE EXCEPTION 'message has no body, attachments or shared posts';
  END IF;
  IF length(p_body) > 5000 THEN RAISE EXCEPTION 'body exceeds 5000 characters'; END IF;
  PERFORM set_config('app.trace_id', p_trace_id::text, true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_channels WHERE channel_id = p_channel_id;
  IF p_reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chat_messages m WHERE m.id = p_reply_to_message_id AND m.channel_id = p_channel_id) THEN
    RAISE EXCEPTION 'reply target not in this chat';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  SELECT * INTO v_row FROM public.chat_messages WHERE id = p_id::text LIMIT 1;
  IF FOUND THEN RETURN v_row; END IF;
  INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids,
    shared_post_ids, reply_to_message_id, attachment_meta, agora_event_id, created_at)
  VALUES (p_id::text, p_channel_id, v_workspace_id, v_actor, p_body, p_mentions, p_attachment_asset_ids,
    p_shared_post_ids, p_reply_to_message_id, p_attachment_meta, NULL, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_sync_enqueue_membership_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_type text;
BEGIN
  IF NEW.active IS NOT DISTINCT FROM OLD.active THEN RETURN NEW; END IF;
  v_type := CASE WHEN NEW.active THEN 'member_add' ELSE 'member_remove' END;
  INSERT INTO public.chat_sync_events (workspace_id, event_type, channel_id, user_id)
  SELECT gm.workspace_id, v_type, c.channel_id, gm.user_id
  FROM public.group_members gm
  JOIN public.chat_channels c ON c.channel_id = 'group__' || gm.workspace_id::text || '__' || gm.group_id::text
  WHERE gm.workspace_id = NEW.workspace_id AND gm.user_id = NEW.user_id;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_sync_enqueue_membership_state() FROM PUBLIC;
DROP TRIGGER IF EXISTS chat_sync_workspace_members_active ON public.workspace_members;
CREATE TRIGGER chat_sync_workspace_members_active AFTER UPDATE OF active ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.chat_sync_enqueue_membership_state();
-- END MIGRATION
