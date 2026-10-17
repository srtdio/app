-- The creator's sample week (onboarding v13): a sample brief, a team plan holding a
-- sample post that is ready for comments, the plan's card and one voice note with its
-- transcript in the default group. induction_sample_seed puts them into the caller's
-- own workspace when the creator taps Start on the intro card; induction_sample_clear
-- deletes exactly those rows on the clear card's Clear it. The creator's own first post
-- is never touched.
--
-- Sample rows are flagged in a marker table, induction_sample_rows (one row per sample
-- row: kind, the row's id, and created_at for the partitioned chat_messages), rather
-- than a column on five tables: clear deletes what the markers name and nothing else.
-- The workspace owner may read their markers (the app keeps the sample-only steps while
-- a seed exists); every write goes through the two functions.
--
-- Not applied. Waits for Shubham's approval; then applied to v2 (movnexawfhsyuluspxoc)
-- via Supabase MCP and docs/schema.md regenerated.

CREATE TABLE IF NOT EXISTS public.induction_sample_rows (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('brief', 'post', 'plan', 'plan_item', 'chat_message')),
  row_id text NOT NULL,
  -- chat_messages is partitioned on created_at: its key is (id, created_at).
  row_created_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, row_id)
);

ALTER TABLE public.induction_sample_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.induction_sample_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.induction_sample_rows TO authenticated;

DROP POLICY IF EXISTS induction_sample_rows_select_owner ON public.induction_sample_rows;
CREATE POLICY induction_sample_rows_select_owner ON public.induction_sample_rows
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = induction_sample_rows.workspace_id
      AND m.user_id = auth.uid() AND m.role = 'owner' AND m.active
  ));

-- The caller must be the workspace's owner (owner_user_id and an active owner
-- membership). Locks the workspace row so a seed and a clear never interleave.
CREATE OR REPLACE FUNCTION public._induction_sample_owner_lock(p_workspace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;
  SELECT owner_user_id INTO v_owner FROM public.workspaces
   WHERE id = p_workspace_id AND deleted_at IS NULL
   FOR UPDATE;
  IF v_owner IS DISTINCT FROM auth.uid() OR NOT EXISTS (
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = p_workspace_id AND user_id = auth.uid() AND role = 'owner' AND active
  ) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
END; $function$;

REVOKE EXECUTE ON FUNCTION public._induction_sample_owner_lock(uuid) FROM PUBLIC, anon, authenticated;

-- Seeds once per workspace: a second call while the markers exist changes nothing and
-- returns the same ids. Writes no inbox entries (nobody is told about sample rows).
CREATE OR REPLACE FUNCTION public.induction_sample_seed(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_platform text; v_tz text; v_format text; v_today date;
  v_brief uuid; v_post uuid; v_plan uuid; v_item uuid;
  v_brief_no integer; v_post_no integer;
  v_channel text; v_plan_msg text; v_voice_msg text; v_voice_asset uuid; v_at timestamptz;
  v_caption text := 'Behind the scenes at the studio this week.' || chr(10) ||
                    'Three of us, one long table and a lot of coffee.';
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public._induction_sample_owner_lock(p_workspace_id);

  IF EXISTS (SELECT 1 FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id) THEN
    RETURN jsonb_build_object(
      'seeded', false,
      'brief_id', (SELECT row_id FROM public.induction_sample_rows
                    WHERE workspace_id = p_workspace_id AND kind = 'brief' LIMIT 1),
      'post_id',  (SELECT row_id FROM public.induction_sample_rows
                    WHERE workspace_id = p_workspace_id AND kind = 'post' LIMIT 1),
      'plan_id',  (SELECT row_id FROM public.induction_sample_rows
                    WHERE workspace_id = p_workspace_id AND kind = 'plan' LIMIT 1));
  END IF;

  SELECT platform, timezone INTO v_platform, v_tz FROM public.workspaces WHERE id = p_workspace_id;
  v_today := (now() AT TIME ZONE coalesce(v_tz, 'UTC'))::date;
  v_format := CASE v_platform WHEN 'tiktok' THEN 'video' WHEN 'youtube_shorts' THEN 'short'
                              ELSE 'single_image' END;

  -- The brief.
  UPDATE public.workspace_counters SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id RETURNING next_entity_number - 1 INTO v_brief_no;
  IF v_brief_no IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
  INSERT INTO public.briefs (workspace_id, number, title, objective, created_by)
  VALUES (p_workspace_id, v_brief_no, 'Launch week',
          'Tell people the new range is here. Keep it short and warm, one post a day.', v_uid)
  RETURNING id INTO v_brief;

  -- The post, in review so it takes comments, with its first version.
  UPDATE public.workspace_counters SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id RETURNING next_entity_number - 1 INTO v_post_no;
  INSERT INTO public.posts (workspace_id, number, title, caption, owner_user_id, platform, format,
                            stage, origin, brief_id, created_by)
  VALUES (p_workspace_id, v_post_no, 'Behind the scenes', v_caption, v_uid, v_platform, v_format,
          'review', 'brief', v_brief, v_uid)
  RETURNING id INTO v_post;
  INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
  VALUES (v_post, p_workspace_id, 1,
          jsonb_build_object('title', 'Behind the scenes', 'caption', v_caption,
                             'platform', v_platform, 'format', v_format, 'origin', 'brief',
                             'brief_id', v_brief, 'owner_user_id', v_uid),
          v_uid);

  -- The plan: a team plan (the client never sees it, and team plans send no alerts)
  -- holding the sample post.
  INSERT INTO public.plans (workspace_id, title, starts_on, ends_on, audience, created_by)
  VALUES (p_workspace_id, 'Launch week', v_today, v_today + 6, 'team', v_uid)
  RETURNING id INTO v_plan;
  INSERT INTO public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by)
  VALUES (p_workspace_id, v_plan, 'post', 0, v_post, v_uid)
  RETURNING id INTO v_item;

  INSERT INTO public.induction_sample_rows (workspace_id, kind, row_id, created_by) VALUES
    (p_workspace_id, 'brief', v_brief::text, v_uid),
    (p_workspace_id, 'post', v_post::text, v_uid),
    (p_workspace_id, 'plan', v_plan::text, v_uid),
    (p_workspace_id, 'plan_item', v_item::text, v_uid);

  -- The default group: the plan's card and one voice note with its transcript. A
  -- workspace without a default group gets no chat rows.
  SELECT c.channel_id INTO v_channel
    FROM public.groups g
    JOIN public.chat_channels c ON c.channel_type = 'group' AND c.entity_id = g.id
   WHERE g.workspace_id = p_workspace_id AND g.is_default AND g.deleted_at IS NULL
   LIMIT 1;
  IF v_channel IS NOT NULL THEN
    v_at := now();
    v_plan_msg := public.uuidv7()::text;
    INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id, shared_plan_ids,
                                      created_at)
    VALUES (v_plan_msg, v_channel, p_workspace_id, v_uid, ARRAY[v_plan], v_at);
    -- The voice note has no sender (a sample voice, so it reads as received and offers
    -- its transcript). The transcript rides in attachment_meta beside the recording.
    v_voice_msg := public.uuidv7()::text;
    v_voice_asset := public.uuidv7();
    INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id,
                                      attachment_asset_ids, attachment_meta, created_at)
    VALUES (v_voice_msg, v_channel, p_workspace_id, NULL, ARRAY[v_voice_asset],
            jsonb_build_object(v_voice_asset::text, jsonb_build_object(
              'mime', 'audio/mp4', 'name', 'voice-note.m4a', 'size', 96000, 'duration_ms', 9000,
              'peaks', jsonb_build_array(12, 30, 55, 72, 40, 64, 88, 52, 35, 70, 96, 60, 44, 28,
                                         50, 76, 58, 34, 22, 46, 68, 80, 54, 30, 18, 40, 62, 48),
              'transcript', 'Morning team. Can we move the launch post to Thursday and keep the '
                            'caption short? The photo from the studio is perfect. Thanks.')),
            v_at + interval '1 second');
    INSERT INTO public.induction_sample_rows (workspace_id, kind, row_id, row_created_at, created_by)
    VALUES (p_workspace_id, 'chat_message', v_plan_msg, v_at, v_uid),
           (p_workspace_id, 'chat_message', v_voice_msg, v_at + interval '1 second', v_uid);
  END IF;

  PERFORM public.audit_log_write('induction_sample_seed', 'success', p_trace_id, p_workspace_id,
    'workspace', p_workspace_id::text,
    jsonb_build_object('brief_id', v_brief, 'post_id', v_post, 'plan_id', v_plan,
                       'chat_messages', CASE WHEN v_channel IS NULL THEN 0 ELSE 2 END));
  RETURN jsonb_build_object('seeded', true, 'brief_id', v_brief, 'post_id', v_post,
                            'plan_id', v_plan);
END; $function$;

REVOKE EXECUTE ON FUNCTION public.induction_sample_seed(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_sample_seed(uuid, uuid) TO authenticated;

-- Deletes exactly the rows the markers name, then the markers. A second call finds no
-- markers and changes nothing. Cascades reach only rows hanging off the sample rows
-- themselves (the sample post's versions and annotations, the sample plan's reviews).
CREATE OR REPLACE FUNCTION public.induction_sample_clear(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_messages integer; v_items integer; v_plans integer; v_posts integer; v_briefs integer;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public._induction_sample_owner_lock(p_workspace_id);
  IF NOT EXISTS (SELECT 1 FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id) THEN
    RETURN jsonb_build_object('cleared', false);
  END IF;

  DELETE FROM public.chat_messages m
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'chat_message'
     AND m.workspace_id = p_workspace_id AND m.id = s.row_id AND m.created_at = s.row_created_at;
  GET DIAGNOSTICS v_messages = ROW_COUNT;
  DELETE FROM public.plan_items i
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'plan_item'
     AND i.workspace_id = p_workspace_id AND i.id::text = s.row_id;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  DELETE FROM public.plans p
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'plan'
     AND p.workspace_id = p_workspace_id AND p.id::text = s.row_id;
  GET DIAGNOSTICS v_plans = ROW_COUNT;
  DELETE FROM public.posts p
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'post'
     AND p.workspace_id = p_workspace_id AND p.id::text = s.row_id;
  GET DIAGNOSTICS v_posts = ROW_COUNT;
  DELETE FROM public.briefs b
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'brief'
     AND b.workspace_id = p_workspace_id AND b.id::text = s.row_id;
  GET DIAGNOSTICS v_briefs = ROW_COUNT;
  DELETE FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id;

  PERFORM public.audit_log_write('induction_sample_clear', 'success', p_trace_id, p_workspace_id,
    'workspace', p_workspace_id::text,
    jsonb_build_object('chat_messages', v_messages, 'plan_items', v_items, 'plans', v_plans,
                       'posts', v_posts, 'briefs', v_briefs));
  RETURN jsonb_build_object('cleared', true, 'chat_messages', v_messages, 'plan_items', v_items,
                            'plans', v_plans, 'posts', v_posts, 'briefs', v_briefs);
END; $function$;

REVOKE EXECUTE ON FUNCTION public.induction_sample_clear(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_sample_clear(uuid, uuid) TO authenticated;
