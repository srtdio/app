-- Record of objects applied to movnexawfhsyuluspxoc on 2026-11-09 (SQL editor, verified). Do NOT run supabase db push.
-- Emoji reactions on comments and plan comments: plan_item_comment_reactions (RLS, SELECT only) and four
--   SECURITY DEFINER write procs. No notifications on reactions (decision 9 Nov).
CREATE TABLE public.plan_item_comment_reactions (
  comment_id   uuid NOT NULL REFERENCES public.plan_item_comments(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji        text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id, emoji)
);
CREATE INDEX plan_item_comment_reactions_user_idx ON public.plan_item_comment_reactions (user_id);
CREATE INDEX plan_item_comment_reactions_workspace_idx ON public.plan_item_comment_reactions (workspace_id);
ALTER TABLE public.plan_item_comment_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_item_comment_reactions FROM anon, authenticated;
GRANT SELECT ON public.plan_item_comment_reactions TO authenticated;
CREATE POLICY plan_item_comment_reactions_select_visible ON public.plan_item_comment_reactions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plan_item_comments c WHERE c.id = comment_id));

CREATE FUNCTION public.comment_reaction_add(p_comment_id uuid, p_emoji text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_ws uuid; v_deleted timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  SELECT workspace_id, deleted_at INTO v_ws, v_deleted FROM public.comments WHERE id = p_comment_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'comment not found'; END IF;
  IF v_deleted IS NOT NULL THEN RAISE EXCEPTION 'comment deleted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                  WHERE wm.workspace_id = v_ws AND wm.user_id = v_actor AND wm.active)
  THEN RAISE EXCEPTION 'not a member'; END IF;
  INSERT INTO public.comment_reactions (comment_id, user_id, emoji, workspace_id)
  VALUES (p_comment_id, v_actor, p_emoji, v_ws) ON CONFLICT DO NOTHING;
END; $$;

CREATE FUNCTION public.comment_reaction_remove(p_comment_id uuid, p_emoji text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  DELETE FROM public.comment_reactions
   WHERE comment_id = p_comment_id AND user_id = v_actor AND emoji = p_emoji;
END; $$;

CREATE FUNCTION public.plan_item_comment_reaction_add(p_comment_id uuid, p_emoji text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_ws uuid; v_deleted timestamptz; v_vis text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  SELECT workspace_id, deleted_at, visibility INTO v_ws, v_deleted, v_vis
    FROM public.plan_item_comments WHERE id = p_comment_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'comment not found'; END IF;
  IF v_deleted IS NOT NULL THEN RAISE EXCEPTION 'comment deleted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                  WHERE wm.workspace_id = v_ws AND wm.user_id = v_actor AND wm.active)
  THEN RAISE EXCEPTION 'not a member'; END IF;
  IF v_vis <> 'everyone' AND NOT public.is_agency_side_member(v_ws)
  THEN RAISE EXCEPTION 'comment not visible'; END IF;
  INSERT INTO public.plan_item_comment_reactions (comment_id, user_id, emoji, workspace_id)
  VALUES (p_comment_id, v_actor, p_emoji, v_ws) ON CONFLICT DO NOTHING;
END; $$;

CREATE FUNCTION public.plan_item_comment_reaction_remove(p_comment_id uuid, p_emoji text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  DELETE FROM public.plan_item_comment_reactions
   WHERE comment_id = p_comment_id AND user_id = v_actor AND emoji = p_emoji;
END; $$;

REVOKE ALL ON FUNCTION public.comment_reaction_add(uuid,text,uuid), public.comment_reaction_remove(uuid,text,uuid),
  public.plan_item_comment_reaction_add(uuid,text,uuid), public.plan_item_comment_reaction_remove(uuid,text,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.comment_reaction_add(uuid,text,uuid), public.comment_reaction_remove(uuid,text,uuid),
  public.plan_item_comment_reaction_add(uuid,text,uuid), public.plan_item_comment_reaction_remove(uuid,text,uuid)
  TO authenticated;
