-- Applied live 26 Oct 2026 via MCP/SQL editor; this file records it.
-- Speedy B: Activity badge counters + read-path functions.
-- 1. activity_badge_counts: one row per (workspace, user) holding unread and
--    mention counts for unread, undeleted, unsnoozed inbox entries.
--    activity_badge_snoozed: one row per unread, undeleted, snoozed inbox
--    entry; activity_badge_read adds the ones whose snooze is due.
-- 2. _activity_badge_apply keeps both tables in step via statement-level
--    triggers on inbox_entries (insert, update, delete).
-- 3. Backfill of both tables from inbox_entries (same aggregates as the
--    trigger), so a fresh replay matches live.
-- 4. Read-path functions: comment_create, chat_unread_counts,
--    activity_badge_read, chat_open_bundle, plan_bundle_read, posts_list,
--    capabilities_for_workspace, ref_resolve.
-- Function bodies are pg_get_functiondef output from live, verbatim.

BEGIN;

-- (1) Tables.
CREATE TABLE IF NOT EXISTS public.activity_badge_counts (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  unread integer NOT NULL DEFAULT 0,
  mentions integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT activity_badge_counts_pkey PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.activity_badge_snoozed (
  entry_id uuid NOT NULL,
  entry_created_at timestamp with time zone NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  is_mention boolean NOT NULL,
  snoozed_until timestamp with time zone NOT NULL,
  CONSTRAINT activity_badge_snoozed_pkey PRIMARY KEY (entry_id, entry_created_at)
);
CREATE INDEX IF NOT EXISTS activity_badge_snoozed_due_idx
  ON public.activity_badge_snoozed USING btree (workspace_id, user_id, snoozed_until) INCLUDE (is_mention);

ALTER TABLE public.activity_badge_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_badge_snoozed ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activity_badge_counts_select_own ON public.activity_badge_counts;
CREATE POLICY activity_badge_counts_select_own ON public.activity_badge_counts
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = activity_badge_counts.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true))))));

DROP POLICY IF EXISTS activity_badge_snoozed_select_own ON public.activity_badge_snoozed;
CREATE POLICY activity_badge_snoozed_select_own ON public.activity_badge_snoozed
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = activity_badge_snoozed.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.active = true))))));

-- Table privileges mirror live EXACTLY: authenticated SELECT only; anon and
-- service_role none (writes go through the SECURITY DEFINER trigger).
REVOKE ALL ON TABLE public.activity_badge_counts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.activity_badge_counts TO authenticated;
REVOKE ALL ON TABLE public.activity_badge_snoozed FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.activity_badge_snoozed TO authenticated;
-- srtdio_readonly exists only on the hosted project; guard the grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srtdio_readonly') THEN
    GRANT SELECT ON public.activity_badge_counts TO srtdio_readonly;
    GRANT SELECT ON public.activity_badge_snoozed TO srtdio_readonly;
  END IF;
END $$;

-- (2) Trigger function and triggers.
CREATE OR REPLACE FUNCTION public._activity_badge_apply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('activity_badge:' || x.w::text, 0))
      FROM (SELECT DISTINCT n.workspace_id w FROM new_rows n WHERE n.read_at IS NULL AND n.deleted_at IS NULL ORDER BY 1) x;
    INSERT INTO public.activity_badge_counts AS c (workspace_id, user_id, unread, mentions)
    SELECT n.workspace_id, n.user_id, count(*), count(*) FILTER (WHERE n.event_type = 'mention')
      FROM new_rows n WHERE n.read_at IS NULL AND n.deleted_at IS NULL AND n.snoozed_until IS NULL
     GROUP BY 1, 2 ORDER BY 1, 2
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET unread = c.unread + EXCLUDED.unread, mentions = c.mentions + EXCLUDED.mentions, updated_at = now();
    INSERT INTO public.activity_badge_snoozed
    SELECT n.id, n.created_at, n.workspace_id, n.user_id, n.event_type = 'mention', n.snoozed_until
      FROM new_rows n WHERE n.read_at IS NULL AND n.deleted_at IS NULL AND n.snoozed_until IS NOT NULL
    ON CONFLICT (entry_id, entry_created_at) DO NOTHING;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('activity_badge:' || x.w::text, 0))
      FROM (SELECT DISTINCT o.workspace_id w FROM old_rows o WHERE o.read_at IS NULL AND o.deleted_at IS NULL ORDER BY 1) x;
    UPDATE public.activity_badge_counts c SET unread = c.unread - d.u, mentions = c.mentions - d.m, updated_at = now()
      FROM (SELECT o.workspace_id, o.user_id, count(*) u, count(*) FILTER (WHERE o.event_type = 'mention') m
              FROM old_rows o WHERE o.read_at IS NULL AND o.deleted_at IS NULL AND o.snoozed_until IS NULL GROUP BY 1, 2) d
     WHERE c.workspace_id = d.workspace_id AND c.user_id = d.user_id;
    DELETE FROM public.activity_badge_snoozed s USING old_rows o WHERE s.entry_id = o.id AND s.entry_created_at = o.created_at;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('activity_badge:' || x.w::text, 0))
      FROM (SELECT DISTINCT w FROM (SELECT o.workspace_id w FROM old_rows o JOIN new_rows n USING (id, created_at)
              WHERE (o.workspace_id, o.user_id, o.event_type, o.read_at IS NULL, o.deleted_at IS NULL, o.snoozed_until)
                    IS DISTINCT FROM (n.workspace_id, n.user_id, n.event_type, n.read_at IS NULL, n.deleted_at IS NULL, n.snoozed_until)
            UNION SELECT n.workspace_id FROM old_rows o JOIN new_rows n USING (id, created_at)
              WHERE (o.workspace_id, o.user_id, o.event_type, o.read_at IS NULL, o.deleted_at IS NULL, o.snoozed_until)
                    IS DISTINCT FROM (n.workspace_id, n.user_id, n.event_type, n.read_at IS NULL, n.deleted_at IS NULL, n.snoozed_until)) y ORDER BY 1) x;
    WITH chg AS (
      SELECT o.id, o.created_at FROM old_rows o JOIN new_rows n USING (id, created_at)
       WHERE (o.workspace_id, o.user_id, o.event_type, o.read_at IS NULL, o.deleted_at IS NULL, o.snoozed_until)
             IS DISTINCT FROM (n.workspace_id, n.user_id, n.event_type, n.read_at IS NULL, n.deleted_at IS NULL, n.snoozed_until)),
    d AS (
      SELECT o.workspace_id, o.user_id, -1 u, CASE WHEN o.event_type = 'mention' THEN -1 ELSE 0 END m
        FROM old_rows o JOIN chg USING (id, created_at) WHERE o.read_at IS NULL AND o.deleted_at IS NULL AND o.snoozed_until IS NULL
      UNION ALL
      SELECT n.workspace_id, n.user_id, 1, CASE WHEN n.event_type = 'mention' THEN 1 ELSE 0 END
        FROM new_rows n JOIN chg USING (id, created_at) WHERE n.read_at IS NULL AND n.deleted_at IS NULL AND n.snoozed_until IS NULL)
    INSERT INTO public.activity_badge_counts AS c (workspace_id, user_id, unread, mentions)
    SELECT workspace_id, user_id, sum(u), sum(m) FROM d GROUP BY 1, 2 HAVING sum(u) <> 0 OR sum(m) <> 0 ORDER BY 1, 2
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET unread = c.unread + EXCLUDED.unread, mentions = c.mentions + EXCLUDED.mentions, updated_at = now();
    DELETE FROM public.activity_badge_snoozed s USING old_rows o JOIN new_rows n USING (id, created_at)
     WHERE s.entry_id = o.id AND s.entry_created_at = o.created_at
       AND (o.workspace_id, o.user_id, o.event_type, o.read_at IS NULL, o.deleted_at IS NULL, o.snoozed_until)
           IS DISTINCT FROM (n.workspace_id, n.user_id, n.event_type, n.read_at IS NULL, n.deleted_at IS NULL, n.snoozed_until);
    INSERT INTO public.activity_badge_snoozed
    SELECT n.id, n.created_at, n.workspace_id, n.user_id, n.event_type = 'mention', n.snoozed_until
      FROM new_rows n JOIN old_rows o USING (id, created_at)
     WHERE n.read_at IS NULL AND n.deleted_at IS NULL AND n.snoozed_until IS NOT NULL
       AND (o.workspace_id, o.user_id, o.event_type, o.read_at IS NULL, o.deleted_at IS NULL, o.snoozed_until)
           IS DISTINCT FROM (n.workspace_id, n.user_id, n.event_type, n.read_at IS NULL, n.deleted_at IS NULL, n.snoozed_until)
    ON CONFLICT (entry_id, entry_created_at) DO UPDATE
      SET snoozed_until = EXCLUDED.snoozed_until, is_mention = EXCLUDED.is_mention,
          workspace_id = EXCLUDED.workspace_id, user_id = EXCLUDED.user_id;
  END IF;
  RETURN NULL;
END $function$
;
REVOKE ALL ON FUNCTION public._activity_badge_apply() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS inbox_entries_badge_ins ON public.inbox_entries;
CREATE TRIGGER inbox_entries_badge_ins AFTER INSERT ON public.inbox_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION _activity_badge_apply();
DROP TRIGGER IF EXISTS inbox_entries_badge_upd ON public.inbox_entries;
CREATE TRIGGER inbox_entries_badge_upd AFTER UPDATE ON public.inbox_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION _activity_badge_apply();
DROP TRIGGER IF EXISTS inbox_entries_badge_del ON public.inbox_entries;
CREATE TRIGGER inbox_entries_badge_del AFTER DELETE ON public.inbox_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION _activity_badge_apply();

-- (3) Backfill. Same aggregates the trigger maintains.
INSERT INTO public.activity_badge_counts (workspace_id, user_id, unread, mentions)
SELECT n.workspace_id, n.user_id, count(*), count(*) FILTER (WHERE n.event_type = 'mention')
  FROM public.inbox_entries n
 WHERE n.read_at IS NULL AND n.deleted_at IS NULL AND n.snoozed_until IS NULL
 GROUP BY 1, 2
ON CONFLICT (workspace_id, user_id) DO NOTHING;

INSERT INTO public.activity_badge_snoozed (entry_id, entry_created_at, workspace_id, user_id, is_mention, snoozed_until)
SELECT n.id, n.created_at, n.workspace_id, n.user_id, n.event_type = 'mention', n.snoozed_until
  FROM public.inbox_entries n
 WHERE n.read_at IS NULL AND n.deleted_at IS NULL AND n.snoozed_until IS NOT NULL
ON CONFLICT (entry_id, entry_created_at) DO NOTHING;

-- (4) Functions.
CREATE OR REPLACE FUNCTION public.activity_badge_read(p_trace_id uuid, p_workspace_id uuid)
 RETURNS TABLE(unread integer, mentions integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT (coalesce(c.unread, 0) + s.due)::int, (coalesce(c.mentions, 0) + s.due_mentions)::int
    FROM (SELECT 1) one
    LEFT JOIN public.activity_badge_counts c ON c.workspace_id = p_workspace_id AND c.user_id = (SELECT auth.uid())
   CROSS JOIN LATERAL (SELECT count(*) due, count(*) FILTER (WHERE z.is_mention) due_mentions
                         FROM public.activity_badge_snoozed z
                        WHERE z.workspace_id = p_workspace_id AND z.user_id = (SELECT auth.uid()) AND z.snoozed_until <= now()) s;
$function$
;
REVOKE ALL ON FUNCTION public.activity_badge_read(p_trace_id uuid, p_workspace_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.activity_badge_read(p_trace_id uuid, p_workspace_id uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.comment_create(p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid, p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_scope text; v_is_draft boolean := false; v_brief_owner uuid; v_mentioned uuid[]; v_invalid uuid[];
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_entity_type = 'post' AND p_parent_comment_id IS NULL AND EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
         AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF p_entity_type NOT IN ('post','brief') OR p_entity_id IS NULL
     OR p_body IS NULL OR char_length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF char_length(btrim(p_body)) = 0
     AND coalesce(array_length(p_attachment_asset_ids,1),0) = 0 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_parent_comment_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.comments WHERE id=p_parent_comment_id AND parent_comment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_entity_type='post' THEN
    v_scope := 'posts';
    SELECT (stage='draft') INTO v_is_draft FROM public.posts WHERE id=p_entity_id AND workspace_id=p_workspace_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  ELSE
    v_scope := 'briefs';
    SELECT created_by INTO v_brief_owner FROM public.briefs WHERE id=p_entity_id AND workspace_id=p_workspace_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  v_is_draft := coalesce(v_is_draft,false);
  SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_mentioned FROM (
    SELECT val::uuid x FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_mentions)='array' THEN p_mentions ELSE '[]'::jsonb END) val
    UNION ALL
    SELECT lower(t[1])::uuid FROM regexp_matches(p_body, '@\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]', 'g') t
  ) s;
  SELECT array_agg(m) INTO v_invalid FROM unnest(v_mentioned) m
   WHERE NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                      WHERE wm.workspace_id = p_workspace_id AND wm.user_id = m AND wm.active = true
                        AND (p_entity_type <> 'post' OR NOT v_is_draft OR wm.role IN ('owner','admin','agency')));
  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_mention' USING DETAIL = array_to_string(v_invalid, ',');
  END IF;
  BEGIN
    INSERT INTO public.comments (workspace_id, entity_type, entity_id, parent_comment_id, author_user_id,
      body, mentions, attachment_asset_ids)
    VALUES (p_workspace_id, p_entity_type, p_entity_id, p_parent_comment_id, auth.uid(),
      p_body, p_mentions, p_attachment_asset_ids) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF p_attachment_asset_ids IS NOT NULL AND array_length(p_attachment_asset_ids,1) IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
               WHERE v.id = ANY(p_attachment_asset_ids) AND v.workspace_id = p_workspace_id
                 AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'attachment not available'; END IF;
    IF (SELECT count(*) FROM public.asset_versions av
          JOIN public.assets a ON a.id = av.asset_id
         WHERE av.id = ANY(p_attachment_asset_ids) AND av.workspace_id = p_workspace_id
           AND a.deleted_at IS NULL)
       <> array_length(p_attachment_asset_ids,1) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    INSERT INTO public.asset_attachments
      (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
    SELECT av.asset_id, av.id, 'comment', v_id::text, p_workspace_id, (u.ord-1)::int, auth.uid()
    FROM unnest(p_attachment_asset_ids) WITH ORDINALITY AS u(version_id, ord)
    JOIN public.asset_versions av ON av.id = u.version_id;
  END IF;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, p_workspace_id, 'comment', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'active',
         jsonb_build_object('comment_id', v_id), auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id=p_workspace_id AND wm.active = true
    AND wm.user_id <> auth.uid() AND wm.user_id <> ALL(v_mentioned)
    AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
       OR (p_entity_type='brief') );
  IF array_length(v_mentioned,1) IS NOT NULL THEN
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    SELECT wm.user_id, p_workspace_id, 'mention', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', v_id), auth.uid()
    FROM public.workspace_members wm
    WHERE wm.workspace_id=p_workspace_id AND wm.active = true
      AND wm.user_id = ANY(v_mentioned) AND wm.user_id <> auth.uid()
      AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
         OR (p_entity_type='brief') );
  END IF;
  PERFORM public.inbox_self_entry(p_workspace_id, 'comment', p_entity_type, p_entity_id::text, v_scope,
    p_entity_id::text, jsonb_build_object('comment_id', v_id));
  PERFORM public.audit_log_write('comment_create','success',p_trace_id,p_workspace_id,'comment',v_id::text,
          jsonb_build_object('entity_type',p_entity_type));
  RETURN v_id;
END; $function$
;
REVOKE ALL ON FUNCTION public.comment_create(p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid, p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_trace_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.comment_create(p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid, p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_trace_id uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_unread_counts(p_workspace_id uuid)
 RETURNS TABLE(channel_id text, unread bigint, last_message_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE c_ts constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
BEGIN
  RETURN QUERY EXECUTE format($q$
    SELECT c.channel_id, coalesce(u.unread, 0)::bigint, lm.last_message_at
      FROM public.chat_channels c
     CROSS JOIN LATERAL (SELECT max(m.created_at) AS last_message_at FROM public.chat_messages m
                          WHERE m.channel_id = c.channel_id AND m.workspace_id = $1 AND m.deleted_at IS NULL
                            AND m.created_at > %L::timestamptz AND m.created_at <= %L::timestamptz) lm
      LEFT JOIN public.chat_unread_counters u ON u.channel_id = c.channel_id AND u.user_id = (SELECT auth.uid())
     WHERE c.workspace_id = $1 AND lm.last_message_at IS NOT NULL$q$,
    to_char((now() - interval '90 days') at time zone 'UTC', c_ts),
    to_char((now() + interval '1 minute') at time zone 'UTC', c_ts))
  USING p_workspace_id;
END $function$
;
REVOKE ALL ON FUNCTION public.chat_unread_counts(p_workspace_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts(p_workspace_id uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_open_bundle(p_trace_id uuid, p_workspace_id uuid, p_channel_id text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  c_ts constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  c_cols constant text := 'm.id, m.channel_id, m.workspace_id, m.sender_user_id, m.body, m.mentions, m.attachment_asset_ids, m.shared_post_ids, m.shared_brief_ids, m.shared_plan_ids, m.reply_to_message_id, m.forwarded_from_message_id, m.attachment_meta, m.agora_event_id, m.created_at, m.edited_at, m.deleted_at, m.thread_root_message_id, m.removed_files';
  v_hi timestamptz := now() + interval '1 minute';
  v_limit int := CASE WHEN p_since IS NULL THEN 50 ELSE 200 END;
  v_rows jsonb := '[]'; v_page jsonb; v_n int := 0; v_k int; v_lo timestamptz; v_up timestamptz;
  v_ids text[]; v_oldest timestamptz; v_missing text[]; v_quoted jsonb := '[]';
  v_cursors jsonb := '[]'; v_cur_ids text[]; v_cur_ats timestamptz[]; v_cursor_msgs jsonb := '[]'; v_counts jsonb := '[]';
  v_shared uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_channels c WHERE c.channel_id = p_channel_id AND c.workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;
  IF p_since IS NOT NULL THEN
    EXECUTE format($q$SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id), '[]'), count(*) FROM (SELECT %s FROM public.chat_messages m
      WHERE m.channel_id = $1 AND m.created_at >= %L::timestamptz AND m.created_at < %L::timestamptz ORDER BY m.created_at, m.id LIMIT $2) t$q$,
      c_cols, to_char(p_since at time zone 'UTC', c_ts), to_char(v_hi at time zone 'UTC', c_ts))
    INTO v_rows, v_n USING p_channel_id, v_limit + 1;
  ELSE
    v_up := v_hi;
    FOREACH v_lo IN ARRAY ARRAY[v_hi - interval '30 days', v_hi - interval '90 days', NULL]::timestamptz[] LOOP
      EXECUTE format($q$SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC, t.id DESC), '[]'), count(*) FROM (SELECT %s FROM public.chat_messages m
        WHERE m.channel_id = $1 AND m.created_at < %L::timestamptz %s ORDER BY m.created_at DESC, m.id DESC LIMIT $2) t$q$,
        c_cols, to_char(v_up at time zone 'UTC', c_ts),
        CASE WHEN v_lo IS NULL THEN '' ELSE format('AND m.created_at >= %L::timestamptz', to_char(v_lo at time zone 'UTC', c_ts)) END)
      INTO v_page, v_k USING p_channel_id, v_limit + 1 - v_n;
      v_rows := v_rows || v_page; v_n := v_n + v_k;
      EXIT WHEN v_n > v_limit OR v_lo IS NULL;
      v_up := v_lo;
    END LOOP;
  END IF;
  v_rows := (SELECT coalesce(jsonb_agg(x.e ORDER BY CASE WHEN p_since IS NULL THEN -x.o ELSE x.o END), '[]')
               FROM jsonb_array_elements(v_rows) WITH ORDINALITY x(e, o) WHERE x.o <= v_limit);
  SELECT array_agg(e->>'id'), min((e->>'created_at')::timestamptz) INTO v_ids, v_oldest FROM jsonb_array_elements(v_rows) e;
  IF v_ids IS NOT NULL THEN
    SELECT array_agg(DISTINCT x) INTO v_missing FROM (
      SELECT e->>'reply_to_message_id' x FROM jsonb_array_elements(v_rows) e
      UNION ALL SELECT e->>'thread_root_message_id' FROM jsonb_array_elements(v_rows) e) s
     WHERE x IS NOT NULL AND x <> ALL (v_ids);
    IF v_missing IS NOT NULL THEN
      EXECUTE format($q$SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM (SELECT %s FROM public.chat_messages m
        WHERE m.id = ANY ($1) AND m.created_at >= %L::timestamptz AND m.created_at < %L::timestamptz) t$q$,
        c_cols, to_char((v_oldest - interval '31 days') at time zone 'UTC', c_ts), to_char(v_hi at time zone 'UTC', c_ts))
      INTO v_quoted USING v_missing;
      v_missing := ARRAY(SELECT x FROM unnest(v_missing) x WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_quoted) q WHERE q->>'id' = x));
      IF cardinality(v_missing) > 0 THEN
        EXECUTE format($q$SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM (SELECT %s FROM public.chat_messages m
          WHERE m.id = ANY ($1) AND m.created_at < %L::timestamptz) t$q$,
          c_cols, to_char((v_oldest - interval '31 days') at time zone 'UTC', c_ts))
        INTO v_page USING v_missing;
        v_quoted := v_quoted || v_page;
      END IF;
    END IF;
    EXECUTE format($q$SELECT coalesce(jsonb_agg(jsonb_build_object('root_id', r, 'reply_count', n, 'last_reply_at', l)), '[]')
      FROM (SELECT m.thread_root_message_id r, count(*) n, max(m.created_at) l FROM public.chat_messages m
             WHERE m.channel_id = $1 AND m.thread_root_message_id = ANY ($2) AND m.deleted_at IS NULL
               AND m.created_at >= %L::timestamptz AND m.created_at <= %L::timestamptz GROUP BY 1) t$q$,
      to_char(v_oldest at time zone 'UTC', c_ts), to_char(v_hi at time zone 'UTC', c_ts))
    INTO v_counts USING p_channel_id, v_ids[1:200];
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', rc.user_id, 'last_read_message_id', rc.last_read_message_id,
           'last_read_at', rc.last_read_at, 'read_at', rc.read_at)), '[]'),
         array_agg(DISTINCT rc.last_read_message_id), array_agg(DISTINCT rc.last_read_at)
    INTO v_cursors, v_cur_ids, v_cur_ats FROM public.chat_read_cursors rc WHERE rc.channel_id = p_channel_id;
  IF v_cur_ids IS NOT NULL THEN
    EXECUTE format($q$SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'created_at', m.created_at)), '[]')
      FROM public.chat_messages m WHERE m.id = ANY ($1) AND m.created_at = ANY (%L::timestamptz[])$q$,
      (SELECT array_agg(to_char(a at time zone 'UTC', c_ts)) FROM unnest(v_cur_ats) a)::text)
    INTO v_cursor_msgs USING v_cur_ids;
  END IF;
  v_shared := ARRAY(SELECT p.id FROM public.plans p WHERE p.workspace_id = p_workspace_id AND p.audience = 'client' AND p.deleted_at IS NULL
                      AND p.starts_on <= ((now() + interval '14 hours') at time zone 'UTC')::date
                      AND p.ends_on >= ((now() - interval '12 hours') at time zone 'UTC')::date
                    ORDER BY p.ends_on, p.starts_on, p.id LIMIT 100);
  RETURN jsonb_build_object(
    'server_now', now(),
    'messages', v_rows, 'has_more', v_n > v_limit, 'quoted', v_quoted,
    'reactions', (SELECT coalesce(jsonb_agg(jsonb_build_object('message_id', r.message_id, 'emoji', r.emoji, 'user_id', r.user_id)), '[]')
                    FROM public.chat_reactions r WHERE r.message_id = ANY (coalesce(v_ids, '{}'))),
    'read_cursors', v_cursors, 'cursor_messages', v_cursor_msgs, 'reply_counts', v_counts,
    'marks', (SELECT coalesce(jsonb_agg(to_jsonb(k)), '[]') FROM public.chat_message_marks k WHERE k.channel_id = p_channel_id),
    'scheduled', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.send_at), '[]') FROM public.chat_scheduled_messages s
                   WHERE s.channel_id = p_channel_id AND s.status = 'scheduled'),
    'open_posts', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'number', p.number, 'title', p.title, 'format', p.format,
                     'target_date', p.target_date, 'stage_entered_at', p.stage_entered_at, 'thumbnail_asset_version_id', th.v) ORDER BY p.stage_entered_at), '[]')
                     FROM (SELECT * FROM public.posts p WHERE p.workspace_id = p_workspace_id AND p.stage = 'review' AND p.deleted_at IS NULL
                            ORDER BY p.stage_entered_at LIMIT 100) p
                     LEFT JOIN LATERAL (SELECT aa.asset_version_id v FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                       WHERE aa.entity_type = 'post' AND aa.entity_id = p.id::text AND aa.deleted_at IS NULL AND av.mime_type LIKE 'image/%'
                       ORDER BY aa.position, aa.attached_at LIMIT 1) th ON true),
    'open_post_count', (SELECT count(*) FROM public.posts p WHERE p.workspace_id = p_workspace_id AND p.stage = 'review' AND p.deleted_at IS NULL),
    'shared_plan_ids', to_jsonb(v_shared),
    'open_briefs', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'number', b.number, 'title', b.title, 'created_at', b.created_at) ORDER BY b.created_at DESC), '[]')
                      FROM (SELECT b.id, b.number, b.title, b.created_at FROM public.briefs b WHERE b.workspace_id = p_workspace_id AND b.status = 'open'
                              AND b.deleted_at IS NULL ORDER BY b.created_at DESC LIMIT 100) b),
    'open_brief_count', (SELECT count(*) FROM public.briefs b WHERE b.workspace_id = p_workspace_id AND b.status = 'open' AND b.deleted_at IS NULL));
END $function$
;
REVOKE ALL ON FUNCTION public.chat_open_bundle(p_trace_id uuid, p_workspace_id uuid, p_channel_id text, p_since timestamp with time zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_open_bundle(p_trace_id uuid, p_workspace_id uuid, p_channel_id text, p_since timestamp with time zone) TO authenticated;

CREATE OR REPLACE FUNCTION public.plan_bundle_read(p_trace_id uuid, p_workspace_id uuid, p_plan_ids uuid[] DEFAULT NULL::uuid[], p_range_start date DEFAULT NULL::date, p_range_end date DEFAULT NULL::date, p_only_shared boolean DEFAULT false, p_channel_id text DEFAULT NULL::text, p_before_starts_on date DEFAULT NULL::date, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  c_ts constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  c_page constant int := 12;
  v_tz text; v_plans jsonb; v_ids uuid[]; v_created timestamptz; v_more boolean := false; v_next jsonb;
  v_items jsonb; v_item_ids uuid[]; v_post_ids uuid[]; v_concept_ids uuid[];
  v_drafts jsonb := '[]'; v_chunk int; v_loose jsonb := '[]'; v_loose_ids uuid[] := '{}'; v_last timestamptz;
BEGIN
  SELECT w.timezone INTO v_tz FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF v_tz IS NULL THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  WITH sel AS (
    SELECT pl.* FROM public.plans pl
     WHERE pl.workspace_id = p_workspace_id AND p_plan_ids IS NOT NULL AND pl.id = ANY (p_plan_ids[1:200])
    UNION ALL
    SELECT q.* FROM (
      SELECT pl.* FROM public.plans pl
       WHERE pl.workspace_id = p_workspace_id AND p_plan_ids IS NULL
         AND (NOT p_only_shared OR pl.audience = 'client')
         AND (p_range_start IS NULL OR (pl.starts_on <= p_range_end AND pl.ends_on >= p_range_start))
         AND (p_before_starts_on IS NULL OR (pl.starts_on, pl.id) < (p_before_starts_on, p_before_id))
       ORDER BY pl.starts_on DESC, pl.id DESC
       LIMIT c_page + 1) q),
  page AS (
    SELECT s.*, row_number() OVER (ORDER BY s.starts_on DESC, s.id DESC) rn FROM sel s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'workspace_id', p.workspace_id, 'title', p.title, 'starts_on', p.starts_on,
           'ends_on', p.ends_on, 'audience', p.audience, 'created_by', p.created_by, 'updated_at', p.updated_at) ORDER BY p.starts_on, p.id)
           FILTER (WHERE p_plan_ids IS NOT NULL OR p.rn <= c_page), '[]'),
         coalesce(array_agg(p.id) FILTER (WHERE p_plan_ids IS NOT NULL OR p.rn <= c_page), '{}'),
         min(p.created_at) FILTER (WHERE p_plan_ids IS NOT NULL OR p.rn <= c_page),
         p_plan_ids IS NULL AND count(*) > c_page,
         (SELECT jsonb_build_object('starts_on', x.starts_on, 'id', x.id) FROM page x WHERE x.rn = c_page)
    INTO v_plans, v_ids, v_created, v_more, v_next
    FROM page p;
  IF NOT v_more THEN v_next := NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', it.id, 'plan_id', it.plan_id, 'kind', it.kind, 'position', it.position, 'title', it.title,
           'description', it.description, 'post_id', it.post_id, 'created_at', it.created_at, 'updated_at', it.updated_at, 'target_date', it.target_date)), '[]'),
         coalesce(array_agg(it.id), '{}'), coalesce(array_agg(it.post_id) FILTER (WHERE it.post_id IS NOT NULL), '{}'),
         coalesce(array_agg(it.id) FILTER (WHERE it.kind = 'concept'), '{}')
    INTO v_items, v_item_ids, v_post_ids, v_concept_ids
    FROM public.plan_items it WHERE it.plan_id = ANY (v_ids);
  IF cardinality(v_ids) > 0 THEN
    FOR v_chunk IN 0 .. (cardinality(v_ids) - 1) / 100 LOOP
      v_drafts := v_drafts || coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM public.plan_draft_rows(v_ids[v_chunk*100+1 : v_chunk*100+100]) d), '[]');
    END LOOP;
  END IF;
  IF p_plan_ids IS NULL AND p_range_start IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'stage', p.stage, 'target_date', p.target_date) ORDER BY p.target_date, p.id), '[]'),
           coalesce(array_agg(p.id), '{}')
      INTO v_loose, v_loose_ids
      FROM public.posts p
     WHERE p.workspace_id = p_workspace_id AND p.deleted_at IS NULL
       AND p.target_date >= ((p_range_start - 1)::timestamp AT TIME ZONE 'UTC')
       AND p.target_date <= (((p_range_end + 1)::timestamp + interval '23:59:59') AT TIME ZONE 'UTC');
  END IF;
  IF p_channel_id IS NOT NULL AND cardinality(v_ids) = 1 THEN
    EXECUTE format($q$SELECT max(m.created_at) FROM public.chat_messages m WHERE m.channel_id = $1 AND m.shared_plan_ids @> ARRAY[$2]::uuid[]
      AND m.deleted_at IS NULL AND m.created_at >= %L::timestamptz AND m.created_at < %L::timestamptz$q$,
      to_char(v_created at time zone 'UTC', c_ts), to_char((now() + interval '1 minute') at time zone 'UTC', c_ts))
    INTO v_last USING p_channel_id, v_ids[1];
  END IF;
  RETURN jsonb_build_object(
    'timezone', v_tz, 'plans', v_plans, 'items', v_items, 'draft_rows', v_drafts,
    'next_cursor', v_next,
    'reviews', (SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', r.item_id, 'side', r.side, 'status', r.status,
                  'reviewed_by', r.reviewed_by, 'reviewed_at', r.reviewed_at)), '[]') FROM public.plan_item_reviews r WHERE r.item_id = ANY (v_item_ids)),
    'posts', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'stage', p.stage, 'title', p.title, 'format', p.format, 'target_date', p.target_date)), '[]')
                FROM public.posts p WHERE p.id = ANY (v_post_ids)),
    'comment_counts', (SELECT coalesce(jsonb_object_agg(c.item_id, c.n), '{}') FROM (SELECT pc.item_id, count(*) n FROM public.plan_item_comments pc
                         WHERE pc.item_id = ANY (v_item_ids) AND pc.deleted_at IS NULL GROUP BY 1) c),
    'thumbs', jsonb_build_object(
      'posts', (SELECT coalesce(jsonb_object_agg(t.entity_id, t.v), '{}') FROM (
                  SELECT DISTINCT ON (aa.entity_id) aa.entity_id, aa.asset_version_id v
                    FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                   WHERE aa.entity_type = 'post' AND aa.entity_id = ANY (ARRAY(SELECT x::text FROM unnest(v_post_ids || v_loose_ids) x))
                     AND aa.deleted_at IS NULL AND av.mime_type LIKE 'image/%'
                   ORDER BY aa.entity_id, aa.position, aa.attached_at) t),
      'concepts', (SELECT coalesce(jsonb_object_agg(t.entity_id, CASE WHEN t.v IS NOT NULL THEN jsonb_build_object('kind', 'image', 'versionId', t.v)
                                                                       ELSE jsonb_build_object('kind', 'file') END), '{}') FROM (
                  SELECT aa.entity_id, (array_agg(aa.asset_version_id ORDER BY aa.position, aa.attached_at) FILTER (WHERE av.mime_type LIKE 'image/%'))[1] v
                    FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                   WHERE aa.entity_type = 'plan_item' AND aa.entity_id = ANY (ARRAY(SELECT x::text FROM unnest(v_concept_ids) x)) AND aa.deleted_at IS NULL
                   GROUP BY aa.entity_id) t)),
    'also_in', CASE WHEN p_plan_ids IS NOT NULL AND cardinality(v_ids) = 1 THEN
                 (SELECT coalesce(jsonb_object_agg(a.post_id, a.titles), '{}') FROM (
                    SELECT o.post_id, jsonb_agg(pl.title ORDER BY pl.title) titles
                      FROM (SELECT DISTINCT it.post_id, it.plan_id FROM public.plan_items it
                             WHERE it.post_id = ANY (v_post_ids) AND it.deleted_at IS NULL AND it.plan_id <> v_ids[1]) o
                      JOIN public.plans pl ON pl.id = o.plan_id GROUP BY o.post_id) a) END,
    'loose_posts', v_loose,
    'any_plan', CASE WHEN cardinality(v_ids) > 0 THEN true
                     WHEN p_plan_ids IS NULL AND p_range_start IS NOT NULL THEN EXISTS (SELECT 1 FROM public.plans pl
                       WHERE pl.workspace_id = p_workspace_id AND (NOT p_only_shared OR pl.audience = 'client'))
                     ELSE false END,
    'last_sent_at', v_last);
END $function$
;
REVOKE ALL ON FUNCTION public.plan_bundle_read(p_trace_id uuid, p_workspace_id uuid, p_plan_ids uuid[], p_range_start date, p_range_end date, p_only_shared boolean, p_channel_id text, p_before_starts_on date, p_before_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.plan_bundle_read(p_trace_id uuid, p_workspace_id uuid, p_plan_ids uuid[], p_range_start date, p_range_end date, p_only_shared boolean, p_channel_id text, p_before_starts_on date, p_before_id uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.posts_list(p_trace_id uuid, p_workspace_id uuid, p_stage text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, workspace_id uuid, title text, caption text, bucket_id uuid, owner_user_id uuid, platform text, format text, stage text, target_date timestamp with time zone, origin text, brief_id uuid, row_version bigint, created_by uuid, created_at timestamp with time zone, updated_at timestamp with time zone, deleted_at timestamp with time zone, stage_entered_at timestamp with time zone, legacy_author_name text, number integer, approved_by uuid, approved_at timestamp with time zone, approved_on_behalf_of uuid, thumbnail_asset_version_id uuid, first_media_asset_version_id uuid, first_media_kind text, first_media_width integer, first_media_height integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT p.id, p.workspace_id, p.title, p.caption, p.bucket_id, p.owner_user_id, p.platform, p.format, p.stage, p.target_date, p.origin,
         p.brief_id, p.row_version, p.created_by, p.created_at, p.updated_at, p.deleted_at, p.stage_entered_at, p.legacy_author_name,
         p.number, p.approved_by, p.approved_at, p.approved_on_behalf_of,
         th.v, fm.asset_version_id, fm.kind, fm.width, fm.height
    FROM (SELECT * FROM public.posts p0
           WHERE p0.workspace_id = p_workspace_id AND p0.deleted_at IS NULL
             AND (p_stage IS NULL OR p0.stage = p_stage) AND (p_before IS NULL OR p0.created_at < p_before)
           ORDER BY p0.workspace_id, p0.stage, p0.created_at DESC
           LIMIT least(greatest(coalesce(p_limit, 50), 0), 500)) p
    LEFT JOIN LATERAL (SELECT aa.asset_version_id v FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                        WHERE aa.entity_type = 'post' AND aa.entity_id = p.id::text AND aa.deleted_at IS NULL AND av.mime_type LIKE 'image/%'
                        ORDER BY aa.position, aa.attached_at LIMIT 1) th ON true
    LEFT JOIN LATERAL (SELECT aa.asset_version_id, CASE WHEN av.mime_type LIKE 'image/%' THEN 'image' ELSE 'video' END kind, av.width, av.height
                         FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                        WHERE aa.entity_type = 'post' AND aa.entity_id = p.id::text AND aa.deleted_at IS NULL
                          AND (av.mime_type LIKE 'image/%' OR av.mime_type LIKE 'video/%')
                        ORDER BY aa.position, aa.attached_at LIMIT 1) fm ON true
   ORDER BY p.workspace_id, p.stage, p.created_at DESC;
$function$
;
REVOKE ALL ON FUNCTION public.posts_list(p_trace_id uuid, p_workspace_id uuid, p_stage text, p_limit integer, p_before timestamp with time zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.posts_list(p_trace_id uuid, p_workspace_id uuid, p_stage text, p_limit integer, p_before timestamp with time zone) TO authenticated;

CREATE OR REPLACE FUNCTION public.capabilities_for_workspace(p_trace_id uuid, p_workspace_id uuid)
 RETURNS TABLE(capability text, allowed boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT wrp.capability, wrp.allowed FROM public.workspace_role_permissions wrp
    JOIN public.workspace_members wm ON wm.workspace_id = wrp.workspace_id AND wm.role = wrp.role
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = (SELECT auth.uid()) AND wm.active = true;
$function$
;
REVOKE ALL ON FUNCTION public.capabilities_for_workspace(p_trace_id uuid, p_workspace_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.capabilities_for_workspace(p_trace_id uuid, p_workspace_id uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ref_resolve(p_trace_id uuid, p_workspace_key text, p_kind text, p_number integer)
 RETURNS TABLE(workspace_id uuid, entity_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT w.id, CASE p_kind
      WHEN 'post'  THEN (SELECT p.id FROM public.posts p WHERE p.workspace_id = w.id AND p.number = p_number AND p.deleted_at IS NULL)
      WHEN 'brief' THEN (SELECT b.id FROM public.briefs b WHERE b.workspace_id = w.id AND b.number = p_number AND b.deleted_at IS NULL) END
    FROM public.workspaces w WHERE w.key = p_workspace_key;
$function$
;
REVOKE ALL ON FUNCTION public.ref_resolve(p_trace_id uuid, p_workspace_key text, p_kind text, p_number integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ref_resolve(p_trace_id uuid, p_workspace_key text, p_kind text, p_number integer) TO authenticated;

COMMIT;
