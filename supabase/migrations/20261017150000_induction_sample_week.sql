-- The first-time tour's sample workspace (onboarding v13): "Kestrel & Rowe", a fashion
-- brand, lived in for a week. Every first tour (creator, invited creator, approver) runs
-- in it: induction_sample_seed fills the caller's workspace with it (five sample people,
-- two groups and a DM with their chat, 37 posts with photos, the Pink ruffle set's
-- comments and annotations, six briefs, an 18-file library, a client plan for the
-- current week and the seeder's activity); induction_sample_clear deletes exactly those
-- rows. The fixture's ME is the seeder. A person's own work (the creator's Launch day)
-- is never seeded or touched. Source of truth for every row: the peek fixture.
--
-- Sample rows are flagged in a marker table, induction_sample_rows (one row per sample
-- row: kind, the row's key as text, created_at for the partitioned chat_messages and
-- inbox_entries, an optional tag the app looks up: review_post, voice_note, plan,
-- brief). Clear deletes what the markers name (plus what hangs off those rows only:
-- comments anyone wrote on a sample post or brief, the sample DM and group's chat,
-- attachments of sample files). induction_sample_seeds keeps one row per workspace and
-- seeder (seeded_at, cleared_at): at most one live sample per workspace, and a person is
-- never seeded twice in the same workspace (reload, second device). A sample is cleared
-- by its seeder or the owner, by a real member joining (an invite or an accept, anyone
-- but the owner, the seeder and the five sample people), or lazily once it is two hours
-- old (induction_state and induction_sample_seed clear an expired sample first).
--
-- The five sample people exist once, globally: auth users that cannot sign in (empty
-- password, unconfirmed, banned) with completed profiles, email opt-in off. Their
-- avatars and every sample file ship with the app under public/induction-sample/; the
-- r2_key prefix induction-sample/ marks a file that is in no bucket, uses no storage
-- and may be shared by every workspace (the unique r2_key indexes skip it).
--
-- Nothing is sent: the seed writes no outbox row (chat_sync_events rows its group
-- inserts enqueue are removed in the same transaction, the new channels are stamped
-- synced so the Agora sync never creates them), its plan items are added while the plan
-- is still a team plan (_plan_notify writes nothing for team plans) and the seeder's
-- sample activity is stamped email_sent_at so the catch-up email skips it.
--
-- Not applied. Waits for Shubham's approval; then applied to v2 (movnexawfhsyuluspxoc)
-- via Supabase MCP and docs/schema.md regenerated.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

-- Sample avatars are the app's own static files (/induction-sample/av-*.jpg, gp-*.jpg).
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_avatar_url_check;
ALTER TABLE public.users ADD CONSTRAINT users_avatar_url_check CHECK (
  avatar_url IS NULL OR avatar_url ~ '^https?://' OR avatar_url ~ '^/induction-sample/[a-z0-9-]+\.jpg$');
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_avatar_url_check;
ALTER TABLE public.groups ADD CONSTRAINT groups_avatar_url_check CHECK (
  avatar_url IS NULL OR avatar_url ~ '^https?://' OR avatar_url ~ '^/induction-sample/[a-z0-9-]+\.jpg$');

-- A sample file's key is the same in every workspace that holds the sample.
DROP INDEX IF EXISTS public.asset_versions_r2_key_key;
CREATE UNIQUE INDEX asset_versions_r2_key_key ON public.asset_versions USING btree (r2_key)
  WHERE r2_key IS NOT NULL AND r2_key NOT LIKE 'induction-sample/%';
ALTER TABLE public.asset_renditions DROP CONSTRAINT IF EXISTS asset_renditions_r2_key_key;
DROP INDEX IF EXISTS public.asset_renditions_r2_key_key;
CREATE UNIQUE INDEX asset_renditions_r2_key_key ON public.asset_renditions USING btree (r2_key)
  WHERE r2_key NOT LIKE 'induction-sample/%';

CREATE TABLE IF NOT EXISTS public.induction_sample_rows (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  row_id text NOT NULL,
  -- chat_messages and inbox_entries are partitioned on created_at: their key is (id, created_at).
  row_created_at timestamptz,
  tag text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, row_id)
);
ALTER TABLE public.induction_sample_rows ADD COLUMN IF NOT EXISTS tag text;
ALTER TABLE public.induction_sample_rows DROP CONSTRAINT IF EXISTS induction_sample_rows_kind_check;
ALTER TABLE public.induction_sample_rows ADD CONSTRAINT induction_sample_rows_kind_check CHECK (kind IN (
  'member', 'group', 'group_member', 'chat_channel', 'chat_read_cursor', 'chat_message',
  'post', 'post_version', 'post_annotation', 'asset', 'asset_version', 'asset_rendition',
  'asset_attachment', 'comment', 'brief', 'plan', 'plan_item', 'plan_item_review', 'inbox_entry'));
CREATE UNIQUE INDEX IF NOT EXISTS induction_sample_rows_tag_uq
  ON public.induction_sample_rows (workspace_id, tag) WHERE tag IS NOT NULL;

ALTER TABLE public.induction_sample_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.induction_sample_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.induction_sample_rows TO authenticated;

-- Every active member reads the markers (the app tells sample rows from real ones on
-- every route); writes go through the functions only.
DROP POLICY IF EXISTS induction_sample_rows_select_owner ON public.induction_sample_rows;
DROP POLICY IF EXISTS induction_sample_rows_select_member ON public.induction_sample_rows;
CREATE POLICY induction_sample_rows_select_member ON public.induction_sample_rows
  FOR SELECT TO authenticated
  USING (public.is_active_workspace_member(workspace_id));

-- One row per workspace and seeder. cleared_at IS NULL is the workspace's live sample
-- (at most one); the row stays after a clear so that person is never seeded again there.
CREATE TABLE IF NOT EXISTS public.induction_sample_seeds (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  seeded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  seeded_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  clear_reason text CHECK (clear_reason IN ('seeder', 'owner', 'member_joined', 'expired')),
  PRIMARY KEY (workspace_id, seeded_by),
  CHECK ((cleared_at IS NULL) = (clear_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS induction_sample_seeds_live_uq
  ON public.induction_sample_seeds (workspace_id) WHERE cleared_at IS NULL;
ALTER TABLE public.induction_sample_seeds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.induction_sample_seeds FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The five sample people (global, created once)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._induction_sample_people()
 RETURNS uuid[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- Riya Menon, Arjun Shah, Dev Kapoor, Neha Rao, Meera Iyer.
  SELECT ARRAY['5a3b1e00-0000-4000-8000-000000000001', '5a3b1e00-0000-4000-8000-000000000002',
               '5a3b1e00-0000-4000-8000-000000000003', '5a3b1e00-0000-4000-8000-000000000004',
               '5a3b1e00-0000-4000-8000-000000000005']::uuid[];
$function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_people() FROM PUBLIC, anon, authenticated;

-- No password, never confirmed, banned: these accounts cannot sign in. The signup
-- trigger mirrors each into public.users; the profile is filled in once below.
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        banned_until, confirmation_token, recovery_token, email_change_token_new,
                        email_change, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        is_sso_user, is_anonymous)
SELECT '00000000-0000-0000-0000-000000000000'::uuid, p.id, 'authenticated', 'authenticated', p.email,
       '', NULL, '2999-12-31 00:00:00+00', '', '', '', '',
       jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'),
                          'induction_sample', true),
       jsonb_build_object('full_name', p.name), now(), now(), false, false
  FROM (VALUES
    ('5a3b1e00-0000-4000-8000-000000000001'::uuid, 'Riya Menon', 'riya@sample.srtd.io'),
    ('5a3b1e00-0000-4000-8000-000000000002'::uuid, 'Arjun Shah', 'arjun@sample.srtd.io'),
    ('5a3b1e00-0000-4000-8000-000000000003'::uuid, 'Dev Kapoor', 'dev@sample.srtd.io'),
    ('5a3b1e00-0000-4000-8000-000000000004'::uuid, 'Neha Rao',   'neha@sample.srtd.io'),
    ('5a3b1e00-0000-4000-8000-000000000005'::uuid, 'Meera Iyer', 'meera@sample.srtd.io')
  ) AS p(id, name, email)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, display_name, designation, avatar_url, username, timezone,
                          profile_completed_at, email_opt_in)
VALUES
  ('5a3b1e00-0000-4000-8000-000000000001', 'Riya Menon', 'Brand manager',  '/induction-sample/av-riya.jpg',  'riya.menon.sample',  'Asia/Kolkata', now(), false),
  ('5a3b1e00-0000-4000-8000-000000000002', 'Arjun Shah', 'Creative lead',  '/induction-sample/av-arjun.jpg', 'arjun.shah.sample',  'Asia/Kolkata', now(), false),
  ('5a3b1e00-0000-4000-8000-000000000003', 'Dev Kapoor', 'Designer',       '/induction-sample/av-dev.jpg',   'dev.kapoor.sample',  'Asia/Kolkata', now(), false),
  ('5a3b1e00-0000-4000-8000-000000000004', 'Neha Rao',   'Copywriter',     '/induction-sample/av-neha.jpg',  'neha.rao.sample',    'Asia/Kolkata', now(), false),
  ('5a3b1e00-0000-4000-8000-000000000005', 'Meera Iyer', 'Marketing head', '/induction-sample/av-meera.jpg', 'meera.iyer.sample',  'Asia/Kolkata', now(), false)
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, designation = EXCLUDED.designation,
      avatar_url = EXCLUDED.avatar_url, username = EXCLUDED.username, timezone = EXCLUDED.timezone,
      profile_completed_at = EXCLUDED.profile_completed_at, email_opt_in = false
  WHERE public.users.profile_completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Internal helpers (no EXECUTE for anyone but the definer functions below)
-- ---------------------------------------------------------------------------

-- A uuid v7 carrying p_at's time, so sample rows sort by their story time.
CREATE OR REPLACE FUNCTION public._induction_sample_uuid_at(p_at timestamptz)
 RETURNS uuid
 LANGUAGE sql
 VOLATILE
 SET search_path TO ''
AS $function$
  SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
           placing substring(int8send(floor(extract(epoch from p_at) * 1000)::bigint) from 3)
           from 1 for 6), 52, 1), 53, 1), 'hex')::uuid;
$function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_uuid_at(timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._induction_sample_mark(p_workspace_id uuid, p_kind text, p_row_id text,
  p_row_created_at timestamptz DEFAULT NULL, p_tag text DEFAULT NULL)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  INSERT INTO public.induction_sample_rows (workspace_id, kind, row_id, row_created_at, tag, created_by)
  VALUES (p_workspace_id, p_kind, p_row_id, p_row_created_at, p_tag, auth.uid());
$function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_mark(uuid, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;

-- One sample file: the asset, its single version (current), both marked.
CREATE OR REPLACE FUNCTION public._induction_sample_asset(p_workspace_id uuid, p_by uuid, p_at timestamptz,
  p_file text, p_filename text, p_display_name text, p_kind text, p_mime text, p_size bigint,
  p_width integer, p_height integer, p_pages integer, p_duration_ms integer, p_origin text,
  OUT asset_id uuid, OUT version_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.assets (workspace_id, filename, display_name, uploaded_by, uploaded_at, origin)
  VALUES (p_workspace_id, p_filename, p_display_name, p_by, p_at, p_origin)
  RETURNING id INTO asset_id;
  INSERT INTO public.asset_versions (asset_id, workspace_id, version_number, r2_key, mime_type, size_bytes,
                                     width, height, duration_ms, page_count, uploaded_by, uploaded_at, kind)
  VALUES (asset_id, p_workspace_id, 1, 'induction-sample/' || p_file, p_mime, p_size,
          p_width, p_height, p_duration_ms, p_pages, p_by, p_at, p_kind)
  RETURNING id INTO version_id;
  UPDATE public.assets SET current_version_id = version_id WHERE id = asset_id;
  PERFORM public._induction_sample_mark(p_workspace_id, 'asset', asset_id::text);
  PERFORM public._induction_sample_mark(p_workspace_id, 'asset_version', version_id::text);
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_asset(uuid, uuid, timestamptz, text, text, text, text, text, bigint, integer, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._induction_sample_attach(p_workspace_id uuid, p_asset_id uuid,
  p_version_id uuid, p_entity_type text, p_entity_id uuid, p_position integer, p_by uuid, p_at timestamptz)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.asset_attachments (asset_id, asset_version_id, entity_type, entity_id, workspace_id,
                                        position, attached_by, attached_at)
  VALUES (p_asset_id, p_version_id, p_entity_type, p_entity_id::text, p_workspace_id, p_position, p_by, p_at)
  RETURNING id INTO v_id;
  PERFORM public._induction_sample_mark(p_workspace_id, 'asset_attachment', v_id::text);
  RETURN v_id;
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_attach(uuid, uuid, uuid, text, uuid, integer, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._induction_sample_msg(p_workspace_id uuid, p_channel_id text,
  p_sender uuid, p_body text, p_at timestamptz, p_shared_post_ids uuid[] DEFAULT NULL,
  p_shared_plan_ids uuid[] DEFAULT NULL, p_attachment_asset_ids uuid[] DEFAULT NULL,
  p_attachment_meta jsonb DEFAULT NULL, p_tag text DEFAULT NULL)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_id text := public._induction_sample_uuid_at(p_at)::text;
BEGIN
  INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, shared_post_ids,
                                    shared_plan_ids, attachment_asset_ids, attachment_meta, created_at)
  VALUES (v_id, p_channel_id, p_workspace_id, p_sender, p_body, p_shared_post_ids, p_shared_plan_ids,
          p_attachment_asset_ids, p_attachment_meta, p_at);
  PERFORM public._induction_sample_mark(p_workspace_id, 'chat_message', v_id, p_at, p_tag);
  RETURN v_id;
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_msg(uuid, text, uuid, text, timestamptz, uuid[], uuid[], uuid[], jsonb, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._induction_sample_cursor(p_workspace_id uuid, p_channel_id text,
  p_user_id uuid, p_message_id text, p_read_at timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_at timestamptz; v_n integer;
BEGIN
  IF p_channel_id IS NULL OR p_message_id IS NULL THEN RETURN; END IF;
  SELECT created_at INTO v_at FROM public.chat_messages
   WHERE id = p_message_id AND channel_id = p_channel_id LIMIT 1;
  -- An existing cursor is the person's own: it is left as it is and not marked.
  INSERT INTO public.chat_read_cursors (channel_id, user_id, workspace_id, last_read_message_id,
                                        last_read_at, read_at)
  VALUES (p_channel_id, p_user_id, p_workspace_id, p_message_id, v_at, greatest(v_at, p_read_at))
  ON CONFLICT (channel_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public._induction_sample_mark(p_workspace_id, 'chat_read_cursor',
                                          p_channel_id || '|' || p_user_id::text);
  END IF;
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_cursor(uuid, text, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;

-- The caller must be an active member. Locks the workspace row so seeds and clears in
-- one workspace never interleave. Returns the caller's role.
DROP FUNCTION IF EXISTS public._induction_sample_owner_lock(uuid);
CREATE OR REPLACE FUNCTION public._induction_sample_member_lock(p_workspace_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  SELECT role INTO v_role FROM public.workspace_members
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid() AND active;
  RETURN v_role;
END; $function$;

REVOKE EXECUTE ON FUNCTION public._induction_sample_member_lock(uuid) FROM PUBLIC, anon, authenticated;

-- Clears the workspace's sample when it is two hours old (reason 'expired'). Called
-- first by induction_state and induction_sample_seed; no cron. Returns whether it cleared.
CREATE OR REPLACE FUNCTION public._induction_sample_expire(p_workspace_id uuid, p_trace_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.induction_sample_seeds
                  WHERE workspace_id = p_workspace_id AND cleared_at IS NULL
                    AND seeded_at < now() - interval '2 hours') THEN
    RETURN false;
  END IF;
  RETURN coalesce((public._induction_sample_clear(p_workspace_id, p_trace_id, 'expired') ->> 'cleared')::boolean, false);
END; $function$;

REVOKE EXECUTE ON FUNCTION public._induction_sample_expire(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

-- Any active member whose own tour is not finished may seed. Returns seeded:false (and
-- changes nothing) when a sample is already there (reason 'already_seeded', with its
-- ids), when this person had a sample here before (reason 'seeded_before') or finished
-- their tour (reason 'tour_done'). An expired sample is cleared first.
CREATE OR REPLACE FUNCTION public.induction_sample_seed(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_people uuid[] := public._induction_sample_people();
  c_riya  constant uuid := '5a3b1e00-0000-4000-8000-000000000001';
  c_arjun constant uuid := '5a3b1e00-0000-4000-8000-000000000002';
  c_dev   constant uuid := '5a3b1e00-0000-4000-8000-000000000003';
  c_neha  constant uuid := '5a3b1e00-0000-4000-8000-000000000004';
  c_meera constant uuid := '5a3b1e00-0000-4000-8000-000000000005';
  v_who jsonb;
  v_platform text; v_tz text; v_today date; v_formats text[]; v_fmt text;
  v_start date; v_number integer; v_id uuid; v_ver uuid; v_aid uuid; v_vid uuid; v_att uuid;
  v_by uuid; v_at timestamptz; v_created timestamptz; v_target timestamptz; v_k integer;
  r record;
  v_posts jsonb := '{}'::jsonb; v_briefs jsonb := '{}'::jsonb; v_comments jsonb := '{}'::jsonb;
  v_ruffle_version uuid; v_ruffle_slide1 uuid; v_caption text; v_span integer;
  v_plan uuid; v_item uuid;
  v_group uuid; v_group_channel text; v_crew uuid; v_crew_name text := 'Shoot crew';
  v_crew_channel text; v_dm text; v_base timestamptz;
  v_covers uuid[] := ARRAY[]::uuid[]; v_cover_meta jsonb := '{}'::jsonb;
  v_voice uuid; v_peaks jsonb;
  v_msg jsonb := '{}'::jsonb;
  v_role text; v_client boolean; v_team uuid; v_in_group boolean := false; v_me_group uuid;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_role := public._induction_sample_member_lock(p_workspace_id);
  PERFORM public._induction_sample_expire(p_workspace_id, p_trace_id);

  IF EXISTS (SELECT 1 FROM public.induction_sample_seeds
              WHERE workspace_id = p_workspace_id AND cleared_at IS NULL) THEN
    RETURN jsonb_build_object('seeded', false, 'reason', 'already_seeded',
             'seeded_by', (SELECT seeded_by FROM public.induction_sample_seeds
                            WHERE workspace_id = p_workspace_id AND cleared_at IS NULL))
      || coalesce((SELECT jsonb_object_agg(tag || '_id', row_id) FROM public.induction_sample_rows
                    WHERE workspace_id = p_workspace_id AND tag IS NOT NULL), '{}'::jsonb);
  END IF;
  IF EXISTS (SELECT 1 FROM public.induction_sample_seeds
              WHERE workspace_id = p_workspace_id AND seeded_by = v_uid) THEN
    RETURN jsonb_build_object('seeded', false, 'reason', 'seeded_before');
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_private
              WHERE user_id = v_uid AND induction_done_at IS NOT NULL) THEN
    RETURN jsonb_build_object('seeded', false, 'reason', 'tour_done');
  END IF;
  INSERT INTO public.induction_sample_seeds (workspace_id, seeded_by, seeded_at)
  VALUES (p_workspace_id, v_uid, v_now);
  -- An approver (client) sees what a client sees: not the agency's Shoot crew, and the
  -- plan's team side is the agency's (Arjun), not theirs.
  v_client := v_role = 'client';
  v_team := CASE WHEN v_client THEN c_arjun ELSE v_uid END;

  SELECT platform, coalesce(timezone, 'UTC') INTO v_platform, v_tz
    FROM public.workspaces WHERE id = p_workspace_id;
  v_today := (v_now AT TIME ZONE v_tz)::date;
  -- The fixture's week is 12 to 18 Oct seen on the 14th: today - 2 .. today + 4.
  v_start := v_today - 2;
  v_formats := CASE v_platform
      WHEN 'instagram'      THEN ARRAY['reel','story','carousel','single_image']
      WHEN 'x'              THEN ARRAY['text','single_image','video','thread']
      WHEN 'threads'        THEN ARRAY['text','single_image','carousel','video']
      WHEN 'linkedin'       THEN ARRAY['text','single_image','carousel','video','link']
      WHEN 'facebook'       THEN ARRAY['text','single_image','carousel','video','reel','story','link']
      WHEN 'tiktok'         THEN ARRAY['video']
      WHEN 'youtube_shorts' THEN ARRAY['short']
    END;
  v_who := jsonb_build_object('me', v_uid, 'riya', c_riya, 'arjun', c_arjun, 'dev', c_dev,
                              'neha', c_neha, 'meera', c_meera);

  -- People: active members since a month ago.
  FOR r IN SELECT * FROM (VALUES (c_riya, 'client', true), (c_arjun, 'agency', true),
                                 (c_dev, 'agency', true), (c_neha, 'agency', true),
                                 (c_meera, 'client', false)) AS t(uid, role, joins) LOOP
    INSERT INTO public.workspace_members (workspace_id, user_id, role, active, invited_by, invited_at,
                                          accepted_at, join_default_group)
    VALUES (p_workspace_id, r.uid, r.role, true, NULL, v_now - interval '30 days',
            v_now - interval '30 days', r.joins)
    RETURNING id INTO v_id;
    PERFORM public._induction_sample_mark(p_workspace_id, 'member', v_id::text);
  END LOOP;

  -- Briefs (client-written), numbered before the posts as in the fixture.
  FOR r IN SELECT * FROM (VALUES
      (4, 'Street-cast portraits', 'Real people, our clothes, their streets.', 'closed', -11, 'meera', ARRAY['br-street.jpg']),
      (5, 'Monsoon colour edit', 'Neon knits against grey skies.', 'closed', -9, 'riya', ARRAY['br-monsoon.jpg']),
      (6, 'Menswear tailoring week', 'Three looks, one tailor, no studio.', 'open', -2, 'riya', ARRAY['br-menswear.jpg']),
      (7, 'AW26 runway reel', 'Backstage to finale in thirty seconds, loud colour only.', 'open', -1, 'meera', ARRAY['br-runway.jpg']),
      (8, 'Holiday gifting shoot', 'Gifts under ₹2,999, shot like a street party.', 'open', -1, 'riya', ARRAY['br-gifting.jpg']),
      (9, 'Disco knits drop', 'Neon knits, mirror balls, real dancers. Loud and happy.', 'open', 0, 'riya', ARRAY['br-disco.jpg', 'disco-2.jpg', 'disco-3.jpg'])
    ) AS t(fixno, title, objective, status, day_off, who, files) ORDER BY fixno LOOP
    v_by := (v_who ->> r.who)::uuid;
    v_created := CASE WHEN r.day_off = 0 THEN v_now - interval '9 hours'
                      ELSE ((v_today + r.day_off) + time '09:00') AT TIME ZONE v_tz END;
    UPDATE public.workspace_counters SET next_entity_number = next_entity_number + 1
     WHERE workspace_id = p_workspace_id RETURNING next_entity_number - 1 INTO v_number;
    IF v_number IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
    INSERT INTO public.briefs (workspace_id, number, title, objective, status, closed_at, closed_by,
                               created_by, created_via, created_at, updated_at)
    VALUES (p_workspace_id, v_number, r.title, r.objective, r.status,
            CASE WHEN r.status = 'closed' THEN ((v_today + r.day_off) + time '18:00') AT TIME ZONE v_tz END,
            CASE WHEN r.status = 'closed' THEN v_by END,
            v_by, 'app', v_created, v_created)
    RETURNING id INTO v_id;
    PERFORM public._induction_sample_mark(p_workspace_id, 'brief', v_id::text, NULL,
                                          CASE WHEN r.fixno = 9 THEN 'brief' END);
    v_briefs := v_briefs || jsonb_build_object(r.fixno::text, jsonb_build_object('id', v_id, 'number', v_number));
    FOR v_k IN 1 .. array_length(r.files, 1) LOOP
      SELECT a.asset_id, a.version_id INTO v_aid, v_vid FROM public._induction_sample_asset(
        p_workspace_id, v_by, v_created, r.files[v_k], 'kr-' || r.files[v_k], NULL, 'image', 'image/jpeg',
        400000, 900, 1125, NULL, NULL, 'library') a;
      PERFORM public._induction_sample_attach(p_workspace_id, v_aid, v_vid, 'brief', v_id, v_k - 1, v_by, v_created);
    END LOOP;
  END LOOP;

  -- Posts: 11 named (Launch day, the owner's own, is not seeded) and 26 more, in the
  -- fixture's number order. plan_pos/plan_day place a post in the plan below.
  FOR r IN
    SELECT * FROM (VALUES
      (2, 42, 'Signal Red co-ord', 'carousel', 'review', 'arjun', E'Signal Red co-ord\nOne colour, head to toe. The AW26 co-ord lands Friday.\n#KestrelAndRowe #AW26 #SignalRed', 120, ARRAY['look-1.jpg','look-2.jpg','look-3.jpg'], ARRAY[1125,1125,1125], NULL::integer, NULL::integer, false, NULL::integer),
      (3, 41, 'Sunburst knot top', 'single_image', 'approved', 'arjun', E'Sunburst knot top\nKnot it once. Wear it all week.', 1560, ARRAY['sunburst.jpg'], ARRAY[1125], 1, 3, true, NULL),
      (4, 43, 'Monochrome edit', 'single_image', 'review', 'dev', E'Monochrome edit\nBlack on black, cut clean.', 300, ARRAY['mono.jpg'], ARRAY[1125], 2, 3, false, NULL),
      (5, 40, 'Tailoring workshop', 'single_image', 'review', 'neha', E'Tailoring workshop\nThree looks, one tailor, no studio.', 1680, ARRAY['tailor.jpg'], ARRAY[1125], 0, 2, false, NULL),
      (6, 44, 'Fabric dye timelapse', 'reel', 'review', 'dev', E'Fabric dye timelapse\nFrom raw cotton to coral in forty seconds.', 420, ARRAY['dye.jpg'], ARRAY[1125], 3, 4, false, NULL),
      (7, 45, 'Backstage BTS', 'single_image', 'draft', 'arjun', E'Backstage BTS\nThe rack before the runway.', 3000, ARRAY['bts.jpg'], ARRAY[1125], 4, 5, false, NULL),
      (8, 46, 'Thank you note', 'single_image', 'draft', 'neha', E'Thank you note\nTo everyone who came to the drop.', 3120, ARRAY['thanks.jpg'], ARRAY[1125], 5, 5, false, NULL),
      (9, 38, 'Runway reel: AW26', 'reel', 'approved', 'arjun', E'Runway reel: AW26\nBackstage to finale in thirty seconds.', 10080, ARRAY['runway.jpg'], ARRAY[1125], 6, 6, true, NULL),
      (10, 39, 'Styling tips carousel', 'carousel', 'parked', 'dev', E'Styling tips carousel\nFive ways to wear the trench.', 12960, ARRAY['styling.jpg'], ARRAY[1125], 7, NULL, false, NULL),
      (11, 47, 'Pink ruffle set', 'carousel', 'review', 'arjun', E'Pink ruffle set\nSoft colour, big sleeves. The ruffle set drops Friday.\n#KestrelAndRowe #AW26', 120, ARRAY['ruffle.jpg','ruffle-2.jpg','ruffle-3.jpg'], ARRAY[1353,1125,1125], NULL, NULL, false, 4320),
      (12, 48, 'Hat and trench', 'single_image', 'review', 'dev', E'Hat and trench\nBlack on red. The trench is back.', 240, ARRAY['trench.jpg'], ARRAY[1403], NULL, NULL, false, 2880)
    ) AS named(n, fixno, title, fmt, stage, who, caption, ago_min, files, heights, plan_pos, plan_day, client_ok, upd_min)
    UNION ALL
    SELECT 12 + m.k, 9 + m.k, m.title, 'single_image', m.stage, m.who,
           m.title || E'\n' || m.line, m.hours * 60, ARRAY[m.file || '.jpg'], ARRAY[1125],
           NULL, NULL, false, NULL
      FROM (VALUES
        (1, 'The white edit', 'draft', 'neha', 'Head to toe in white, shot at noon.', 'np-01', 30),
        (2, 'Studio portraits', 'draft', 'dev', 'Clean light, no props.', 'np-02', 33),
        (3, 'Street cast: Bandra', 'draft', 'arjun', 'Real people, our clothes, their streets.', 'np-03', 36),
        (4, 'Blue hour', 'draft', 'neha', 'Teal on teal, shot at dusk.', 'np-04', 40),
        (5, 'Denim, three ways', 'review', 'dev', 'One jacket, three weeks of outfits.', 'np-05', 10),
        (6, 'Evening edit', 'review', 'arjun', 'The black suit, cut for dinner.', 'np-06', 12),
        (7, 'Knitwear launch', 'review', 'neha', 'Magenta for the cold months.', 'np-07', 14),
        (8, 'The red lip', 'review', 'dev', 'One lipstick, every look.', 'np-08', 16),
        (9, 'Two of us', 'review', 'arjun', 'Matching knits for the couple post.', 'np-09', 20),
        (10, 'Camel season', 'review', 'neha', 'The camel coat is back on the rail.', 'np-10', 22),
        (11, 'Weekend brunch look', 'review', 'dev', 'Florals, flats, done by ten.', 'np-11', 24),
        (12, 'Headscarf story', 'review', 'arjun', 'Silk, tied three ways.', 'np-12', 26),
        (13, 'Sport tailoring', 'approved', 'arjun', 'A blue suit that moves.', 'np-13', 32),
        (14, 'Party season', 'approved', 'neha', 'Red and white, loud on purpose.', 'np-14', 34),
        (15, 'Festive edit', 'approved', 'dev', 'Sequins, satin and the green car.', 'np-15', 38),
        (16, 'Travel capsule', 'approved', 'arjun', 'Five pieces, one bag.', 'np-16', 44),
        (17, 'Red room', 'approved', 'neha', 'One colour, one chair, one look.', 'np-17', 48),
        (18, 'Specs appeal', 'approved', 'dev', 'Glasses as the accessory.', 'np-18', 56),
        (19, 'Back to basics', 'approved', 'arjun', 'The tank top, nothing else.', 'np-19', 60),
        (20, 'Vintage finds', 'parked', 'dev', 'Checks and chrome.', 'np-20', 72),
        (21, 'Night out', 'parked', 'arjun', 'All black, shades on.', 'np-21', 80),
        (22, 'Headwrap, close', 'parked', 'neha', 'Holding for the beauty shoot.', 'np-22', 90),
        (23, 'Campus drop', 'parked', 'dev', 'The print shirt, worn loose.', 'np-23', 100),
        (24, 'Monsoon layers', 'rejected', 'neha', 'Pink knit, grey skies.', 'np-24', 110),
        (25, 'Sunday market', 'rejected', 'arjun', 'Bags full, shot on the move.', 'np-25', 120),
        (26, 'Silk scarf tutorial', 'rejected', 'dev', 'Three knots, one scarf.', 'np-26', 130)
      ) AS m(k, title, stage, who, line, file, hours)
    ORDER BY 2
  LOOP
    v_by := (v_who ->> r.who)::uuid;
    v_at := v_now - make_interval(mins => r.ago_min);
    v_created := v_at - interval '24 hours';
    v_target := CASE
      WHEN r.plan_pos IS NOT NULL AND r.plan_day IS NULL THEN NULL
      WHEN r.plan_day IS NOT NULL THEN ((v_start + r.plan_day) + time '09:00') AT TIME ZONE v_tz
      ELSE v_now + interval '2 days' END;
    v_fmt := CASE
      WHEN r.fmt = ANY (v_formats) THEN r.fmt
      WHEN r.fmt = 'reel' AND 'video' = ANY (v_formats) THEN 'video'
      WHEN 'single_image' = ANY (v_formats) THEN 'single_image'
      ELSE v_formats[1] END;
    UPDATE public.workspace_counters SET next_entity_number = next_entity_number + 1
     WHERE workspace_id = p_workspace_id RETURNING next_entity_number - 1 INTO v_number;
    INSERT INTO public.posts (workspace_id, number, title, caption, owner_user_id, platform, format, stage,
                              stage_entered_at, approved_by, approved_at, target_date, origin, created_by,
                              created_at, updated_at)
    VALUES (p_workspace_id, v_number, r.title, r.caption, v_by, v_platform, v_fmt, r.stage, v_at,
            CASE WHEN r.stage = 'approved' THEN c_riya END, CASE WHEN r.stage = 'approved' THEN v_at END,
            v_target, 'manual', v_by, v_created,
            CASE WHEN r.upd_min IS NULL THEN v_at ELSE v_now - make_interval(mins => r.upd_min) END)
    RETURNING id INTO v_id;
    PERFORM public._induction_sample_mark(p_workspace_id, 'post', v_id::text, NULL,
                                          CASE WHEN r.n = 11 THEN 'review_post' END);
    -- Version 1, as post_create writes it.
    INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by, created_at)
    VALUES (v_id, p_workspace_id, 1,
            jsonb_build_object('title', r.title, 'caption', r.caption, 'platform', v_platform,
              'format', v_fmt, 'target_date', v_target, 'bucket_id', NULL, 'owner_user_id', v_by,
              'origin', 'manual', 'brief_id', NULL),
            v_by, CASE WHEN r.n = 11 THEN v_now - interval '26 hours' ELSE v_created END)
    RETURNING id INTO v_ver;
    PERFORM public._induction_sample_mark(p_workspace_id, 'post_version', v_ver::text);
    FOR v_k IN 1 .. array_length(r.files, 1) LOOP
      SELECT a.asset_id, a.version_id INTO v_aid, v_vid FROM public._induction_sample_asset(
        p_workspace_id, v_by, v_at, r.files[v_k], 'kr-' || r.files[v_k], NULL, 'image', 'image/jpeg',
        480000, 900, r.heights[v_k], NULL, NULL, 'library') a;
      v_att := public._induction_sample_attach(p_workspace_id, v_aid, v_vid, 'post', v_id, v_k - 1, v_by, v_at);
      IF r.n = 11 AND v_k = 1 THEN v_ruffle_slide1 := v_att; END IF;
    END LOOP;
    IF r.n = 11 THEN v_ruffle_version := v_ver; v_caption := r.caption; END IF;
    v_posts := v_posts || jsonb_build_object(r.n::text, jsonb_build_object(
      'id', v_id, 'number', v_number, 'plan_pos', r.plan_pos, 'client_ok', r.client_ok));
  END LOOP;

  -- Comments: Pink ruffle set's thread (a checkpoint, its reply, a pin) and two more.
  FOR r IN SELECT * FROM (VALUES
      (1, 'riya', 11, 'Say lands Friday, not drops.', 180, NULL::integer, 1, false),
      (2, 'dev', 11, 'Changing it now.', 150, 1, NULL, false),
      (3, 'arjun', 11, 'Warm the skin tone here, please.', 1, NULL, NULL, false),
      (4, 'riya', 4, NULL, 360, NULL, NULL, true),
      (5, 'meera', 5, 'Love the fit. Go for it.', 1200, NULL, NULL, false)
    ) AS t(n, who, post_n, body, ago_min, parent_n, ledger_seq, mentions_me) ORDER BY n LOOP
    v_at := v_now - make_interval(mins => r.ago_min);
    v_id := public._induction_sample_uuid_at(v_at);
    INSERT INTO public.comments (id, workspace_id, entity_type, entity_id, parent_comment_id, author_user_id,
                                 body, mentions, ledger_seq, created_at)
    VALUES (v_id, p_workspace_id, 'post', (v_posts -> r.post_n::text ->> 'id')::uuid,
            (v_comments ->> r.parent_n::text)::uuid, (v_who ->> r.who)::uuid,
            CASE WHEN r.mentions_me THEN '@[' || v_uid::text || '] can we see this one in black too?'
                 ELSE r.body END,
            CASE WHEN r.mentions_me THEN jsonb_build_array(v_uid::text) END, r.ledger_seq, v_at);
    PERFORM public._induction_sample_mark(p_workspace_id, 'comment', v_id::text);
    v_comments := v_comments || jsonb_build_object(r.n::text, v_id);
  END LOOP;

  -- Pink ruffle set: 'drops Friday' linked to Riya's checkpoint, a pin on slide 1 to Arjun's.
  v_span := position('drops Friday' IN v_caption) - 1;
  INSERT INTO public.post_annotations (post_id, workspace_id, post_version_id, kind, caption_start,
                                       caption_end, comment_id, created_at)
  VALUES ((v_posts -> '11' ->> 'id')::uuid, p_workspace_id, v_ruffle_version, 'caption_span', v_span,
          v_span + length('drops Friday'), (v_comments ->> '1')::uuid, v_now - interval '3 hours')
  RETURNING id INTO v_id;
  PERFORM public._induction_sample_mark(p_workspace_id, 'post_annotation', v_id::text);
  INSERT INTO public.post_annotations (post_id, workspace_id, post_version_id, kind, asset_attachment_id,
                                       image_x, image_y, comment_id, created_at)
  VALUES ((v_posts -> '11' ->> 'id')::uuid, p_workspace_id, v_ruffle_version, 'image_pin', v_ruffle_slide1,
          0.8, 0.74, (v_comments ->> '3')::uuid, v_now - interval '1 minute')
  RETURNING id INTO v_id;
  PERFORM public._induction_sample_mark(p_workspace_id, 'post_annotation', v_id::text);

  -- Library: six PDFs (each with its cover as the thumbnail) and twelve photos.
  FOR r IN SELECT * FROM (VALUES
      (0, 'pdf-women', 'AW26 Lookbook Women.pdf', 0.8, 5, 91804, '2c001a2b7830c2802a3fd8589ea876d3bd2b356828e5741a7d18eae961806fef'),
      (1, 'pdf-men', 'AW26 Lookbook Men.pdf', 0.5, 4, 116670, '3b6946aa20f83fb7fad39da61241b8631aff53469f104943d87a07c41e3b17fb'),
      (2, 'pdf-red', 'Signal Red campaign deck.pdf', 0.8, 4, 195232, 'c8d9e67ad608dd7867fb7515c792599c8d27e549ecf7ad77a65c3fe3ab8552dd'),
      (3, 'pdf-yellow', 'Yellow hour shoot.pdf', 0.6, 3, 176787, 'dcf3d428be0c470db292ebd115befa5bbfee46c42f561e004e2cbaee52b1ac8b'),
      (4, 'pdf-brand', 'Brand guidelines 2026.pdf', 0.7, 4, 133308, '066ea2010210291c6175cea77eac5c50ef8dc826236dd400121180bafbf1508a'),
      (5, 'pdf-price', 'Price list AW26.pdf', 0.4, 2, 122256, 'ddbfd6ba98cf0ceabdb94d5d3483e09113a32a4a6ff317a0b31face30c8537e9')
    ) AS t(k, file, name, mb, pages, thumb_size, thumb_sha) ORDER BY k LOOP
    v_at := v_now - make_interval(hours => (r.k + 1) * 5);
    SELECT a.asset_id, a.version_id INTO v_aid, v_vid FROM public._induction_sample_asset(
      p_workspace_id, c_arjun, v_at, r.file || '.pdf', r.name, r.name, 'pdf', 'application/pdf',
      round(r.mb * 1024 * 1024)::bigint, NULL, NULL, r.pages, NULL, 'library') a;
    INSERT INTO public.asset_renditions (asset_version_id, workspace_id, role, r2_key, mime_type, sha256,
                                         size_bytes, width, height, created_at)
    VALUES (v_vid, p_workspace_id, 'thumbnail', 'induction-sample/' || r.file || '.jpg', 'image/jpeg',
            r.thumb_sha, r.thumb_size, 900, 1125, v_at)
    RETURNING id INTO v_id;
    PERFORM public._induction_sample_mark(p_workspace_id, 'asset_rendition', v_id::text);
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
      (0, 'as-01.jpg', 'denim-portrait-01.jpg'), (1, 'as-02.jpg', 'leather-jacket-shades.jpg'),
      (2, 'as-03.jpg', 'studio-portrait-02.jpg'), (3, 'as-04.jpg', 'couple-camera.jpg'),
      (4, 'as-05.jpg', 'pink-wall-shades.jpg'), (5, 'as-06.jpg', 'shearling-jacket.jpg'),
      (6, 'as-07.jpg', 'print-dress-field.jpg'), (7, 'as-08.jpg', 'red-coat-street.jpg'),
      (8, 'as-09.jpg', 'denim-couple.jpg'), (9, 'as-10.jpg', 'beauty-close-01.jpg'),
      (10, 'as-11.jpg', 'pink-wall-waves.jpg'), (11, 'as-12.jpg', 'silver-blonde-leather.jpg')
    ) AS t(k, file, name) ORDER BY k LOOP
    PERFORM public._induction_sample_asset(p_workspace_id, c_arjun,
      v_now - make_interval(hours => (r.k + 2) * 3), r.file, r.name, r.name, 'image', 'image/jpeg',
      480000, 900, 1125, NULL, NULL, 'library');
  END LOOP;

  -- Plan: AW26 drop fortnight, this week, shared with the client. Its items go in while
  -- it is still a team plan (_plan_notify writes nothing for those), then it is shared.
  INSERT INTO public.plans (workspace_id, title, starts_on, ends_on, audience, created_by, created_at, updated_at)
  VALUES (p_workspace_id, 'AW26 drop fortnight', v_start, v_start + 6, 'team', v_team,
          ((v_start - 3) + time '09:00') AT TIME ZONE v_tz, ((v_start - 3) + time '09:00') AT TIME ZONE v_tz)
  RETURNING id INTO v_plan;
  PERFORM public._induction_sample_mark(p_workspace_id, 'plan', v_plan::text, NULL, 'plan');
  FOR r IN SELECT (e.value ->> 'id')::uuid AS post_id, (e.value ->> 'plan_pos')::integer AS pos,
                  (e.value ->> 'client_ok')::boolean AS client_ok
             FROM jsonb_each(v_posts) e WHERE e.value ->> 'plan_pos' IS NOT NULL
            ORDER BY 2 LOOP
    INSERT INTO public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by, created_at, updated_at)
    VALUES (p_workspace_id, v_plan, 'post', r.pos, r.post_id, v_team,
            ((v_start - 3) + time '09:00') AT TIME ZONE v_tz, ((v_start - 3) + time '09:00') AT TIME ZONE v_tz)
    RETURNING id INTO v_item;
    PERFORM public._induction_sample_mark(p_workspace_id, 'plan_item', v_item::text);
    INSERT INTO public.plan_item_reviews (item_id, workspace_id, side, status, reviewed_by, reviewed_at)
    VALUES (v_item, p_workspace_id, 'team', 'approved', v_team, ((v_start - 2) + time '10:00') AT TIME ZONE v_tz);
    PERFORM public._induction_sample_mark(p_workspace_id, 'plan_item_review', v_item::text || '|team');
    IF r.client_ok THEN
      INSERT INTO public.plan_item_reviews (item_id, workspace_id, side, status, reviewed_by, reviewed_at)
      VALUES (v_item, p_workspace_id, 'client', 'approved', c_riya, v_now - interval '70 minutes');
      PERFORM public._induction_sample_mark(p_workspace_id, 'plan_item_review', v_item::text || '|client');
    END IF;
  END LOOP;
  UPDATE public.plans SET audience = 'client', shared_with_client_at = v_now - interval '150 minutes',
                          shared_with_client_by = v_team
   WHERE id = v_plan;

  -- Chat rooms. The default group keeps its name and photo; Riya, Arjun, Dev and Neha join.
  SELECT g.id, c.channel_id INTO v_group, v_group_channel
    FROM public.groups g
    LEFT JOIN public.chat_channels c ON c.channel_type = 'group' AND c.entity_id = g.id
   WHERE g.workspace_id = p_workspace_id AND g.is_default AND g.deleted_at IS NULL
   LIMIT 1;
  IF v_group IS NOT NULL THEN
    FOR r IN SELECT unnest(ARRAY[c_riya, c_arjun, c_dev, c_neha]) AS uid LOOP
      INSERT INTO public.group_members (group_id, user_id, workspace_id, joined_at)
      VALUES (v_group, r.uid, p_workspace_id, v_now - interval '30 days')
      ON CONFLICT DO NOTHING;
      IF FOUND THEN
        PERFORM public._induction_sample_mark(p_workspace_id, 'group_member', v_group::text || '|' || r.uid::text);
      END IF;
    END LOOP;
  END IF;
  -- The plan card is the seeder's when they are in the default group, else Arjun's.
  v_in_group := v_group IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.group_members WHERE group_id = v_group AND user_id = v_uid);
  v_me_group := CASE WHEN v_in_group THEN v_uid ELSE c_arjun END;
  -- Shoot crew: members go in before its channel exists, as group_create does, so no
  -- sync event is queued; the channel is stamped synced so no Agora group is created.
  IF EXISTS (SELECT 1 FROM public.groups WHERE workspace_id = p_workspace_id AND deleted_at IS NULL
                AND lower(name) = lower(v_crew_name)) THEN
    v_crew_name := 'Shoot crew sample';
  END IF;
  INSERT INTO public.groups (workspace_id, name, created_by, created_at, avatar_url)
  VALUES (p_workspace_id, v_crew_name, v_team, v_now - interval '20 days', '/induction-sample/gp-crew.jpg')
  RETURNING id INTO v_crew;
  PERFORM public._induction_sample_mark(p_workspace_id, 'group', v_crew::text);
  -- The seeder, Dev and Neha; for a client seeder it is the agency's room (Arjun instead).
  FOR r IN SELECT unnest(ARRAY[v_team, c_dev, c_neha]) AS uid LOOP
    INSERT INTO public.group_members (group_id, user_id, workspace_id, joined_at)
    VALUES (v_crew, r.uid, p_workspace_id, v_now - interval '20 days');
    PERFORM public._induction_sample_mark(p_workspace_id, 'group_member', v_crew::text || '|' || r.uid::text);
  END LOOP;
  v_crew_channel := 'group__' || p_workspace_id::text || '__' || v_crew::text;
  INSERT INTO public.chat_channels (channel_id, workspace_id, channel_type, entity_id, last_synced_at, created_at)
  VALUES (v_crew_channel, p_workspace_id, 'group', v_crew, v_now, v_now - interval '20 days');
  PERFORM public._induction_sample_mark(p_workspace_id, 'chat_channel', v_crew_channel);
  -- The owner's DM with Riya (a DM has no Agora object; stamped synced like the worker does).
  v_dm := 'dm__' || p_workspace_id::text || '__' || least(v_uid, c_riya)::text || '__' || greatest(v_uid, c_riya)::text;
  INSERT INTO public.chat_channels (channel_id, workspace_id, channel_type, dm_user_a, dm_user_b, last_synced_at, created_at)
  VALUES (v_dm, p_workspace_id, 'dm', least(v_uid, c_riya), greatest(v_uid, c_riya), v_now, v_now - interval '30 days');
  PERFORM public._induction_sample_mark(p_workspace_id, 'chat_channel', v_dm);

  -- Chat files: three cover options (Arjun) and Dev's voice note.
  FOR v_k IN 1 .. 3 LOOP
    SELECT a.asset_id, a.version_id INTO v_aid, v_vid FROM public._induction_sample_asset(
      p_workspace_id, c_arjun, v_now - interval '70 minutes', 'al-' || v_k || '.jpg', 'cover-' || v_k || '.jpg',
      NULL, 'image', 'image/jpeg', 480000, 900, 1125, NULL, NULL, 'chat') a;
    v_covers := v_covers || v_vid;
    v_cover_meta := v_cover_meta || jsonb_build_object(v_vid::text, jsonb_build_object(
      'mime', 'image/jpeg', 'name', 'cover-' || v_k || '.jpg', 'size', 480000, 'width', 900,
      'height', 1125, 'thumb_w', 300, 'thumb_h', 375));
  END LOOP;
  SELECT a.version_id INTO v_voice FROM public._induction_sample_asset(
    p_workspace_id, c_dev, v_now - interval '65 minutes', 'voice-note.webm', 'voice-note.webm', NULL,
    'audio', 'audio/webm', 22000, NULL, NULL, NULL, 9000, 'chat') a;
  SELECT jsonb_agg(20 + ((k * 37) % 80) ORDER BY k) INTO v_peaks FROM generate_series(0, 47) AS k;

  -- DM (base is 27 hours ago).
  v_base := v_now - interval '27 hours';
  v_msg := v_msg || jsonb_build_object(
    'd1', public._induction_sample_msg(p_workspace_id, v_dm, c_riya, 'Does the caption fit with the hashtags?', v_base),
    'd2', public._induction_sample_msg(p_workspace_id, v_dm, v_uid, 'Yes, 212 characters with the hashtags.', v_base + interval '40 minutes'),
    'd3', public._induction_sample_msg(p_workspace_id, v_dm, c_riya, 'Great, sending it for review after lunch.', v_base + interval '80 minutes'),
    'd4', public._induction_sample_msg(p_workspace_id, v_dm, v_uid, 'Who owns the runway reel?', v_base + interval '120 minutes'),
    'd5', public._induction_sample_msg(p_workspace_id, v_dm, c_riya, 'That is mine, the shot list is in the brief.', v_base + interval '160 minutes'),
    'd6', public._induction_sample_msg(p_workspace_id, v_dm, v_uid, 'Love the new cover look.', v_base + interval '200 minutes'),
    'd7', public._induction_sample_msg(p_workspace_id, v_dm, c_riya, 'Approved from my side. Go ahead for Thursday.', v_base + interval '240 minutes'),
    'd8', public._induction_sample_msg(p_workspace_id, v_dm, v_uid, 'Sunburst knot top is ready for you.', v_base + interval '250 minutes',
                                       ARRAY[(v_posts -> '3' ->> 'id')::uuid]),
    'd9', public._induction_sample_msg(p_workspace_id, v_dm, c_riya, 'Done, it reads well now.', v_base + interval '290 minutes'),
    'd10', public._induction_sample_msg(p_workspace_id, v_dm, v_uid, 'Hat and trench is ready for you.', v_now - interval '2 hours',
                                        ARRAY[(v_posts -> '12' ->> 'id')::uuid]));
  -- Default group.
  IF v_group_channel IS NOT NULL THEN
    v_msg := v_msg || jsonb_build_object(
      'g1', public._induction_sample_msg(p_workspace_id, v_group_channel, c_neha, 'Shot list for Friday is in the brief.', v_base + interval '10 minutes'),
      'g5', public._induction_sample_msg(p_workspace_id, v_group_channel, v_me_group, NULL, v_now - interval '150 minutes',
                                         NULL, ARRAY[v_plan]),
      'g3', public._induction_sample_msg(p_workspace_id, v_group_channel, c_riya, 'Plan looks right. Ticking as I go.', v_now - interval '144 minutes'),
      'g4', public._induction_sample_msg(p_workspace_id, v_group_channel, c_arjun, 'Pink ruffle set is ready for a look.', v_now - interval '2 hours',
                                         ARRAY[(v_posts -> '11' ->> 'id')::uuid]),
      'g2', public._induction_sample_msg(p_workspace_id, v_group_channel, c_arjun, 'Three options for the cover', v_now - interval '70 minutes',
                                         NULL, NULL, v_covers, v_cover_meta),
      'g6', public._induction_sample_msg(p_workspace_id, v_group_channel, c_dev, NULL, v_now - interval '65 minutes',
                                         NULL, NULL, ARRAY[v_voice],
                                         jsonb_build_object(v_voice::text, jsonb_build_object(
                                           'mime', 'audio/webm', 'name', 'voice-note.webm', 'size', 22000,
                                           'duration_ms', 9000, 'peaks', v_peaks,
                                           'transcript', 'Riya wants the red deeper on the co-ord, and the caption under two hundred characters. Can we fix both before six?')),
                                         'voice_note'),
      'g7', public._induction_sample_msg(p_workspace_id, v_group_channel, c_dev, 'Done, it reads well now.', v_now - interval '64 minutes'),
      'g8', public._induction_sample_msg(p_workspace_id, v_group_channel, c_neha, 'Caption is at 184 characters now.', v_now - interval '50 minutes'),
      'g9', public._induction_sample_msg(p_workspace_id, v_group_channel, c_arjun, 'Deeper red on all three slides. The fix goes up at five.', v_now - interval '2 minutes'));
  END IF;
  -- Shoot crew.
  v_msg := v_msg || jsonb_build_object(
    's1', public._induction_sample_msg(p_workspace_id, v_crew_channel, c_neha, 'Call time is 7, the van leaves at 6:30.', v_now - interval '5 hours'),
    's2', public._induction_sample_msg(p_workspace_id, v_crew_channel, c_dev, 'Bringing the backup lights.', v_now - interval '270 minutes'),
    's3', public._induction_sample_msg(p_workspace_id, v_crew_channel, v_team, 'I do.', v_now - interval '30 minutes'));

  -- Read cursors. The seeder has read the DM up to Riya's last message (so the catch-up
  -- email has no unread DM to send), the group up to the plan card, Shoot crew to their
  -- own reply; the sample people have read everything.
  PERFORM public._induction_sample_cursor(p_workspace_id, v_dm, v_uid, v_msg ->> 'd9', v_base + interval '290 minutes');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_dm, c_riya, v_msg ->> 'd10', v_now - interval '1 hour');
  IF v_in_group THEN
    PERFORM public._induction_sample_cursor(p_workspace_id, v_group_channel, v_uid, v_msg ->> 'g5', v_now - interval '144 minutes');
  END IF;
  PERFORM public._induction_sample_cursor(p_workspace_id, v_group_channel, c_riya, v_msg ->> 'g9', v_now - interval '1 minute');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_group_channel, c_arjun, v_msg ->> 'g9', v_now - interval '1 minute');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_group_channel, c_dev, v_msg ->> 'g9', v_now - interval '1 minute');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_group_channel, c_neha, v_msg ->> 'g9', v_now - interval '1 minute');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_crew_channel, v_team, v_msg ->> 's3', v_now - interval '30 minutes');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_crew_channel, c_dev, v_msg ->> 's3', v_now - interval '29 minutes');
  PERFORM public._induction_sample_cursor(p_workspace_id, v_crew_channel, c_neha, v_msg ->> 's3', v_now - interval '29 minutes');

  -- The seeder's activity, in the shapes comment_create, stage_transition and
  -- brief_create write. Stamped email_sent_at: the catch-up email never reports it.
  FOR r IN SELECT * FROM (VALUES
      ('comment', 'post', 11, 'arjun', 3, 1, 'active'),
      ('stage_change', 'post', 3, 'riya', NULL, 70, 'active'),
      ('comment', 'post', 11, 'riya', 1, 180, 'active'),
      ('mention', 'post', 4, 'riya', 4, 360, 'urgent'),
      ('brief_created', 'brief', 9, 'riya', NULL, 540, 'active'),
      ('comment', 'post', 5, 'meera', 5, 1200, 'active')
    ) AS t(event, entity_type, entity_n, actor, comment_n, ago_min, tier) LOOP
    v_at := v_now - make_interval(mins => r.ago_min);
    v_id := public._induction_sample_uuid_at(v_at);
    INSERT INTO public.inbox_entries (id, user_id, workspace_id, event_type, entity_type, entity_id, scope,
                                      scope_key, tier, payload, actor_user_id, email_sent_at, created_at)
    SELECT v_id, v_uid, p_workspace_id, r.event, r.entity_type, x.entity_id,
           CASE r.entity_type WHEN 'post' THEN 'posts' ELSE 'briefs' END,
           CASE r.entity_type WHEN 'post' THEN x.entity_id END, r.tier,
           CASE r.event
             WHEN 'stage_change' THEN jsonb_build_object('from', 'review', 'to', 'approved',
                                                         'actor_role', 'client', 'on_behalf_of', NULL)
             WHEN 'brief_created' THEN jsonb_build_object('title', 'Disco knits drop',
                                                          'number', (v_briefs -> '9' ->> 'number')::integer)
             ELSE jsonb_build_object('comment_id', v_comments ->> r.comment_n::text) END,
           (v_who ->> r.actor)::uuid, v_now, v_at
      FROM (SELECT CASE r.entity_type WHEN 'post' THEN v_posts -> r.entity_n::text ->> 'id'
                                      ELSE v_briefs -> r.entity_n::text ->> 'id' END AS entity_id) x;
    PERFORM public._induction_sample_mark(p_workspace_id, 'inbox_entry', v_id::text, v_at);
  END LOOP;

  -- The default group's member_add rows (its channel exists, so the group_members
  -- trigger queued them): nothing is synced for sample people.
  DELETE FROM public.chat_sync_events
   WHERE workspace_id = p_workspace_id AND processed_at IS NULL AND user_id = ANY (v_people);

  PERFORM public.audit_log_write('induction_sample_seed', 'success', p_trace_id, p_workspace_id,
    'workspace', p_workspace_id::text,
    (SELECT jsonb_object_agg(kind, n) FROM (
       SELECT kind, count(*) AS n FROM public.induction_sample_rows
        WHERE workspace_id = p_workspace_id GROUP BY kind) s));
  RETURN jsonb_build_object('seeded', true,
           'review_post_id', v_posts -> '11' ->> 'id', 'plan_id', v_plan,
           'brief_id', v_briefs -> '9' ->> 'id', 'voice_note_id', v_msg ->> 'g6',
           'group_channel_id', v_group_channel, 'crew_channel_id', v_crew_channel, 'dm_channel_id', v_dm,
           'rows', (SELECT jsonb_object_agg(kind, n) FROM (
                     SELECT kind, count(*) AS n FROM public.induction_sample_rows
                      WHERE workspace_id = p_workspace_id GROUP BY kind) s));
END; $function$;

REVOKE EXECUTE ON FUNCTION public.induction_sample_seed(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_sample_seed(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Clear
-- ---------------------------------------------------------------------------

-- Deletes every marked row, children first, plus what hangs off sample rows only:
-- comments (anyone's) on sample posts and briefs, attachments of sample files, the
-- sample DM and Shoot crew with everything in them, the sample people's own inbox,
-- cursors and memberships. Closes the live induction_sample_seeds row (cleared_at, by,
-- reason) and drops the markers. No caller check: induction_sample_clear checks the
-- seeder or owner; the member trigger and the expiry need none.
CREATE OR REPLACE FUNCTION public._induction_sample_clear(p_workspace_id uuid, p_trace_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_people uuid[] := public._induction_sample_people();
  v_rows jsonb; v_comment_ids uuid[]; v_message_ids text[]; v_asset_ids uuid[];
  v_linked_comments integer;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  SELECT jsonb_object_agg(kind, n) INTO v_rows FROM (
    SELECT kind, count(*) AS n FROM public.induction_sample_rows
     WHERE workspace_id = p_workspace_id GROUP BY kind) s;
  IF v_rows IS NULL THEN
    UPDATE public.induction_sample_seeds SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = p_reason
     WHERE workspace_id = p_workspace_id AND cleared_at IS NULL;
    RETURN jsonb_build_object('cleared', false);
  END IF;

  -- Comments on sample posts and briefs, whoever wrote them, with their attachments.
  SELECT coalesce(array_agg(c.id), ARRAY[]::uuid[]) INTO v_comment_ids
    FROM public.comments c
   WHERE c.workspace_id = p_workspace_id
     AND (c.entity_id::text IN (SELECT row_id FROM public.induction_sample_rows
                                 WHERE workspace_id = p_workspace_id AND kind IN ('post', 'brief'))
          OR c.id::text IN (SELECT row_id FROM public.induction_sample_rows
                             WHERE workspace_id = p_workspace_id AND kind = 'comment'));
  v_linked_comments := cardinality(v_comment_ids) - coalesce((v_rows ->> 'comment')::integer, 0);
  DELETE FROM public.asset_attachments
   WHERE workspace_id = p_workspace_id AND entity_type = 'comment'
     AND entity_id = ANY (v_comment_ids::text[]);
  DELETE FROM public.comments WHERE id = ANY (v_comment_ids);

  -- Activity: the marked entries, and anything the sample people's own inboxes got.
  DELETE FROM public.inbox_entries e
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'inbox_entry'
     AND e.id::text = s.row_id AND e.created_at = s.row_created_at;
  DELETE FROM public.inbox_entries
   WHERE workspace_id = p_workspace_id AND user_id = ANY (v_people);

  -- Chat: marked messages (and reactions and marks on them), cursors, then the sample
  -- channels, which take everything in them along.
  SELECT coalesce(array_agg(row_id), ARRAY[]::text[]) INTO v_message_ids
    FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id AND kind = 'chat_message';
  DELETE FROM public.chat_reactions WHERE workspace_id = p_workspace_id AND message_id = ANY (v_message_ids);
  DELETE FROM public.chat_message_marks WHERE workspace_id = p_workspace_id AND message_id = ANY (v_message_ids);
  DELETE FROM public.chat_messages m
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'chat_message'
     AND m.workspace_id = p_workspace_id AND m.id = s.row_id AND m.created_at = s.row_created_at;
  DELETE FROM public.chat_read_cursors c
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'chat_read_cursor'
     AND c.workspace_id = p_workspace_id AND c.channel_id || '|' || c.user_id::text = s.row_id;
  DELETE FROM public.chat_read_cursors WHERE workspace_id = p_workspace_id AND user_id = ANY (v_people);
  DELETE FROM public.chat_channels c
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'chat_channel'
     AND c.workspace_id = p_workspace_id AND c.channel_id = s.row_id;

  -- Groups: sample memberships (default group and Shoot crew), then Shoot crew.
  DELETE FROM public.group_members gm
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'group_member'
     AND gm.workspace_id = p_workspace_id AND gm.group_id::text || '|' || gm.user_id::text = s.row_id;
  DELETE FROM public.group_members WHERE workspace_id = p_workspace_id AND user_id = ANY (v_people);
  DELETE FROM public.groups g
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'group'
     AND g.workspace_id = p_workspace_id AND g.id::text = s.row_id;

  -- Plan: reviews, items, the plan (items anyone added to it go with it).
  DELETE FROM public.plan_item_reviews r
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'plan_item_review'
     AND r.workspace_id = p_workspace_id AND r.item_id::text || '|' || r.side = s.row_id;
  DELETE FROM public.plan_items i
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'plan_item'
     AND i.workspace_id = p_workspace_id AND i.id::text = s.row_id;
  DELETE FROM public.plans p
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'plan'
     AND p.workspace_id = p_workspace_id AND p.id::text = s.row_id;

  -- Posts and briefs, after their annotations, versions and attachments. Any
  -- attachment of a sample file goes too (the file is leaving).
  SELECT coalesce(array_agg(row_id::uuid), ARRAY[]::uuid[]) INTO v_asset_ids
    FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id AND kind = 'asset';
  DELETE FROM public.post_annotations a
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'post_annotation'
     AND a.workspace_id = p_workspace_id AND a.id::text = s.row_id;
  DELETE FROM public.asset_attachments a
   WHERE a.workspace_id = p_workspace_id
     AND (a.asset_id = ANY (v_asset_ids)
          OR a.id::text IN (SELECT row_id FROM public.induction_sample_rows
                             WHERE workspace_id = p_workspace_id AND kind = 'asset_attachment'));
  DELETE FROM public.post_versions v
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'post_version'
     AND v.workspace_id = p_workspace_id AND v.id::text = s.row_id;
  DELETE FROM public.posts p
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'post'
     AND p.workspace_id = p_workspace_id AND p.id::text = s.row_id;
  DELETE FROM public.briefs b
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'brief'
     AND b.workspace_id = p_workspace_id AND b.id::text = s.row_id;

  -- Files: renditions, then the assets (their versions cascade).
  DELETE FROM public.asset_renditions x
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'asset_rendition'
     AND x.workspace_id = p_workspace_id AND x.id::text = s.row_id;
  DELETE FROM public.assets WHERE workspace_id = p_workspace_id AND id = ANY (v_asset_ids);

  -- The sample people leave, and nothing about them is synced.
  DELETE FROM public.workspace_members wm
   USING public.induction_sample_rows s
   WHERE s.workspace_id = p_workspace_id AND s.kind = 'member'
     AND wm.workspace_id = p_workspace_id AND wm.id::text = s.row_id;
  DELETE FROM public.workspace_members WHERE workspace_id = p_workspace_id AND user_id = ANY (v_people);
  DELETE FROM public.chat_sync_events
   WHERE workspace_id = p_workspace_id AND processed_at IS NULL AND user_id = ANY (v_people);

  UPDATE public.induction_sample_seeds SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = p_reason
   WHERE workspace_id = p_workspace_id AND cleared_at IS NULL;
  DELETE FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id;

  PERFORM public.audit_log_write('induction_sample_clear', 'success', p_trace_id, p_workspace_id,
    'workspace', p_workspace_id::text,
    jsonb_build_object('reason', p_reason, 'rows', v_rows, 'linked_comments', v_linked_comments));
  RETURN jsonb_build_object('cleared', true, 'reason', p_reason, 'rows', v_rows,
                            'linked_comments', v_linked_comments);
END; $function$;

REVOKE EXECUTE ON FUNCTION public._induction_sample_clear(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Clear it: the sample's seeder or the workspace owner. With no live sample it changes
-- nothing (cleared:false), for anyone who is a member.
CREATE OR REPLACE FUNCTION public.induction_sample_clear(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_seeder uuid; v_owner boolean;
BEGIN
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public._induction_sample_member_lock(p_workspace_id);
  SELECT seeded_by INTO v_seeder FROM public.induction_sample_seeds
   WHERE workspace_id = p_workspace_id AND cleared_at IS NULL;
  IF v_seeder IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.induction_sample_rows WHERE workspace_id = p_workspace_id) THEN
    RETURN jsonb_build_object('cleared', false);
  END IF;
  v_owner := EXISTS (SELECT 1 FROM public.workspaces w
                      JOIN public.workspace_members m ON m.workspace_id = w.id AND m.user_id = w.owner_user_id
                     WHERE w.id = p_workspace_id AND w.owner_user_id = auth.uid()
                       AND m.role = 'owner' AND m.active);
  IF v_seeder IS DISTINCT FROM auth.uid() AND NOT v_owner THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  RETURN public._induction_sample_clear(p_workspace_id, p_trace_id,
           CASE WHEN v_seeder = auth.uid() THEN 'seeder' ELSE 'owner' END);
END; $function$;

REVOKE EXECUTE ON FUNCTION public.induction_sample_clear(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_sample_clear(uuid, uuid) TO authenticated;

-- A real person joining (an invite row, or a row becoming active or accepted; anyone
-- but the owner, the sample's seeder and the sample people) clears the sample at once. The trace id is the
-- caller's when the RPC set app.trace_id, else a new one.
CREATE OR REPLACE FUNCTION public._induction_sample_member_joined()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_trace text := current_setting('app.trace_id', true);
BEGIN
  IF NEW.user_id = ANY (public._induction_sample_people()) OR NEW.role = 'owner' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NOT ((NEW.active AND NOT OLD.active)
                               OR (NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL)) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = NEW.workspace_id AND owner_user_id = NEW.user_id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.induction_sample_rows WHERE workspace_id = NEW.workspace_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.induction_sample_seeds
              WHERE workspace_id = NEW.workspace_id AND cleared_at IS NULL AND seeded_by = NEW.user_id) THEN
    RETURN NULL;
  END IF;
  PERFORM public._induction_sample_clear(NEW.workspace_id,
    CASE WHEN v_trace ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN v_trace::uuid ELSE public.uuidv7() END,
    'member_joined');
  RETURN NULL;
END; $function$;

REVOKE EXECUTE ON FUNCTION public._induction_sample_member_joined() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS workspace_members_induction_sample_clear ON public.workspace_members;
CREATE TRIGGER workspace_members_induction_sample_clear
  AFTER INSERT OR UPDATE OF active, accepted_at ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public._induction_sample_member_joined();

-- ---------------------------------------------------------------------------
-- Sample people are not real invites, clients or storage
-- ---------------------------------------------------------------------------

-- induction_state (20261015039000) with client_invited and team_invited ignoring the
-- five sample people, and an expired sample (two hours) cleared first when the caller is
-- a member (so plpgsql and volatile now; the returned object is unchanged). post_id needs
-- no sample filter: it is the caller's own post (created_by = caller), and sample posts
-- are created by the sample people.
CREATE OR REPLACE FUNCTION public.induction_state(p_workspace_id uuid, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_role text; v_member boolean;
BEGIN
  SELECT role INTO v_role FROM public.workspace_members
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid() AND active;
  v_member := v_role IS NOT NULL;
  IF v_member AND p_trace_id IS NOT NULL THEN
    PERFORM public._induction_sample_expire(p_workspace_id, p_trace_id);
  END IF;
  RETURN jsonb_build_object(
    'step',    (SELECT induction_step    FROM public.user_private WHERE user_id = auth.uid()),
    'done_at', (SELECT induction_done_at FROM public.user_private WHERE user_id = auth.uid()),
    'role',    v_role,
    'post_id', (SELECT id FROM public.posts
                 WHERE v_member
                   AND workspace_id = p_workspace_id AND created_by = auth.uid()
                   AND stage <> 'draft' AND deleted_at IS NULL
                 ORDER BY created_at LIMIT 1),
    'client_invited', v_member AND EXISTS (
                 SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = p_workspace_id AND role = 'client' AND removed_at IS NULL
                   AND user_id <> ALL (public._induction_sample_people())),
    'team_invited',   v_member AND EXISTS (
                 SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = p_workspace_id AND role IN ('admin','agency') AND removed_at IS NULL
                   AND user_id <> ALL (public._induction_sample_people()))
  );
END; $function$;

REVOKE EXECUTE ON FUNCTION public.induction_state(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induction_state(uuid, uuid) TO authenticated;

-- member_invite (body as live) with the first-client check ignoring sample clients, so
-- the first real client still sets client_domain. The invite row it inserts clears the
-- sample through the trigger above.
CREATE OR REPLACE FUNCTION public.member_invite(p_workspace_id uuid, p_email text, p_role text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid; v_id uuid; v_domain text; v_client_domain text; v_has_clients boolean;
BEGIN
  IF p_role = 'client' THEN
    SELECT client_domain INTO v_client_domain FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  END IF;
  PERFORM public.member_invite_check(p_workspace_id, p_email, p_role);
  IF p_role = 'client' AND v_client_domain IS NULL THEN
    v_domain := lower(split_part(trim(p_email),'@',2));
    SELECT EXISTS (SELECT 1 FROM public.workspace_members
                    WHERE workspace_id = p_workspace_id AND role = 'client' AND removed_at IS NULL
                      AND user_id <> ALL (public._induction_sample_people()))
      INTO v_has_clients;
    IF NOT v_has_clients THEN
      UPDATE public.workspaces SET client_domain = v_domain, row_version = row_version + 1
       WHERE id = p_workspace_id;
    END IF;
  END IF;
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role, active, invited_by, invited_at)
    VALUES (p_workspace_id, v_uid, p_role, false, auth.uid(), now()) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation OR check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF p_role = 'client' THEN
    UPDATE public.brand_agency_requests SET fulfilled_at = now()
     WHERE requested_by = v_uid AND fulfilled_at IS NULL;
  END IF;
  PERFORM public.audit_log_write('member_invite','success',p_trace_id,p_workspace_id,'workspace_member',v_id::text,
          jsonb_build_object('role',p_role));
  RETURN v_id;
END; $function$;

-- Storage (1 GB plan, 800 MB warning): sample files are served from the app, not the
-- workspace's bucket, so they never count.
CREATE OR REPLACE FUNCTION public.workspace_bytes_used(p_workspace_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select sum(size_bytes) from public.asset_versions where workspace_id = p_workspace_id
                     and (r2_key is null or r2_key not like 'induction-sample/%')),0)::bigint
       + coalesce((select sum(size_bytes) from public.asset_renditions where workspace_id = p_workspace_id
                     and r2_key not like 'induction-sample/%'),0)::bigint;
$function$;

CREATE OR REPLACE FUNCTION public.workspace_storage(p_workspace_id uuid)
 RETURNS TABLE(bytes_used bigint, library_bytes bigint, chat_bytes bigint, voice_bytes bigint, deleted_bytes bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.workspace_bytes_used(p_workspace_id),
    coalesce(sum(v.size_bytes) filter (where a.origin='library' and a.deleted_at is null),0)::bigint,
    coalesce(sum(v.size_bytes) filter (where a.origin='chat' and v.kind<>'audio' and a.deleted_at is null),0)::bigint,
    coalesce(sum(v.size_bytes) filter (where a.origin='chat' and v.kind='audio' and a.deleted_at is null),0)::bigint,
    coalesce(sum(v.size_bytes) filter (where a.deleted_at is not null),0)::bigint
  from public.asset_versions v join public.assets a on a.id = v.asset_id
  where v.workspace_id = p_workspace_id and public.is_active_workspace_member(p_workspace_id)
    and (v.r2_key is null or v.r2_key not like 'induction-sample/%');
$function$;
