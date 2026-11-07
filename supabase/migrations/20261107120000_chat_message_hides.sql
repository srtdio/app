CREATE TABLE IF NOT EXISTS public.chat_message_hides (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  channel_id text NOT NULL REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS chat_message_hides_user_channel_idx ON public.chat_message_hides (user_id, channel_id);
CREATE INDEX IF NOT EXISTS chat_message_hides_channel_idx ON public.chat_message_hides (channel_id);
CREATE INDEX IF NOT EXISTS chat_message_hides_workspace_idx ON public.chat_message_hides (workspace_id);
ALTER TABLE public.chat_message_hides ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_message_hides_select_own ON public.chat_message_hides FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.chat_message_hides FROM authenticated, anon;
GRANT SELECT ON public.chat_message_hides TO authenticated;
CREATE OR REPLACE FUNCTION public.chat_messages_hide(p_message_ids text[], p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_found int; v_wanted int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  v_wanted := coalesce(array_length(p_message_ids, 1), 0);
  IF v_wanted = 0 THEN RETURN; END IF;
  IF v_wanted > 100 THEN RAISE EXCEPTION 'too many messages'; END IF;
  SELECT count(DISTINCT m.id) INTO v_found
  FROM public.chat_messages m
  WHERE m.id = ANY (p_message_ids) AND public.chat_channel_member(m.channel_id, v_actor);
  IF v_found <> (SELECT count(DISTINCT x) FROM unnest(p_message_ids) x) THEN RAISE EXCEPTION 'message not found'; END IF;
  INSERT INTO public.chat_message_hides (user_id, message_id, channel_id, workspace_id)
  SELECT DISTINCT ON (m.id) v_actor, m.id, m.channel_id, m.workspace_id
  FROM public.chat_messages m
  WHERE m.id = ANY (p_message_ids)
  ON CONFLICT (user_id, message_id) DO NOTHING;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_messages_hide(text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_messages_hide(text[], uuid) TO authenticated;
