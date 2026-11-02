-- Private reply: a DM reply to someone's group chat message, post/brief
-- comment or plan comment, carrying a snapshot of the source.
-- Applied to live (movnexawfhsyuluspxoc) on 2026-11-02; this file records it.
-- Idempotent. No DROP.

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS private_reply jsonb
  CONSTRAINT chat_messages_private_reply_check
  CHECK (((private_reply IS NULL) OR (jsonb_typeof(private_reply) = 'object'::text)));

CREATE OR REPLACE FUNCTION public._private_reply_source(p_kind text, p_source_id text, p_actor uuid, p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role text; v_agency boolean; r record;
BEGIN
  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_actor AND wm.active;
  IF v_role IS NULL THEN RETURN NULL; END IF;
  v_agency := v_role IN ('owner','admin','agency');
  IF p_kind = 'chat' THEN
    SELECT m.id, m.channel_id, m.sender_user_id, m.body, m.created_at, g.name
      INTO r FROM public.chat_messages m
      JOIN public.chat_channels c ON c.channel_id = m.channel_id
      JOIN public.groups g ON g.id = c.entity_id
     WHERE m.id = p_source_id AND m.deleted_at IS NULL AND m.workspace_id = p_workspace_id
       AND c.channel_type = 'group' AND g.deleted_at IS NULL;
    IF r.id IS NULL OR NOT public.chat_channel_member(r.channel_id, p_actor) THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('kind','chat','source_id',r.id,'author_user_id',r.sender_user_id,
      'excerpt',left(coalesce(r.body,''),280),'where_label',r.name,'source_created_at',r.created_at,
      'link',jsonb_build_object('channel_id',r.channel_id,'message_id',r.id));
  ELSIF p_kind = 'comment' THEN
    SELECT cm.id, cm.entity_type, cm.entity_id, cm.author_user_id, cm.body, cm.created_at,
           coalesce(p.title, b.title) AS title,
           CASE cm.entity_type
             WHEN 'post' THEN p.id IS NOT NULL AND p.deleted_at IS NULL AND (p.stage <> 'draft' OR v_agency)
             WHEN 'brief' THEN b.id IS NOT NULL AND b.deleted_at IS NULL
             ELSE false END AS visible
      INTO r FROM public.comments cm
      LEFT JOIN public.posts p ON cm.entity_type = 'post' AND p.id = cm.entity_id
      LEFT JOIN public.briefs b ON cm.entity_type = 'brief' AND b.id = cm.entity_id
     WHERE cm.id::text = p_source_id AND cm.deleted_at IS NULL AND cm.workspace_id = p_workspace_id;
    IF r.id IS NULL OR NOT r.visible OR r.author_user_id IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('kind','comment','source_id',r.id,'author_user_id',r.author_user_id,
      'excerpt',left(coalesce(r.body,''),280),'where_label',r.title,'source_created_at',r.created_at,
      'link',jsonb_build_object('entity_type',r.entity_type,'entity_id',r.entity_id,'comment_id',r.id));
  ELSIF p_kind = 'plan_comment' THEN
    SELECT pc.id, pc.author_user_id, pc.body, pc.created_at, i.id AS item_id, i.plan_id, i.title
      INTO r FROM public.plan_item_comments pc
      JOIN public.plan_items i ON i.id = pc.item_id AND i.deleted_at IS NULL
      JOIN public.plans pl ON pl.id = i.plan_id AND pl.deleted_at IS NULL
      LEFT JOIN public.posts po ON po.id = i.post_id
     WHERE pc.id::text = p_source_id AND pc.deleted_at IS NULL AND pc.workspace_id = p_workspace_id
       AND (pl.audience = 'client' OR v_agency)
       AND (pc.visibility = 'everyone' OR v_agency)
       AND (i.kind = 'concept' OR (po.id IS NOT NULL AND po.deleted_at IS NULL AND (po.stage <> 'draft' OR v_agency)));
    IF r.id IS NULL OR r.author_user_id IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('kind','plan_comment','source_id',r.id,'author_user_id',r.author_user_id,
      'excerpt',left(coalesce(r.body,''),280),'where_label',r.title,'source_created_at',r.created_at,
      'link',jsonb_build_object('plan_id',r.plan_id,'item_id',r.item_id,'comment_id',r.id));
  END IF;
  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public._private_reply_source(text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_private_reply_send(p_id uuid, p_channel_id text, p_trace_id uuid, p_source_kind text, p_source_id text, p_body text DEFAULT NULL::text, p_mentions jsonb DEFAULT NULL::jsonb, p_attachment_asset_ids uuid[] DEFAULT NULL::uuid[], p_attachment_meta jsonb DEFAULT NULL::jsonb)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_ch record; v_snap jsonb; v_author uuid; v_row public.chat_messages;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_id IS NULL OR p_trace_id IS NULL OR p_source_kind IS NULL OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'p_id, p_trace_id, p_source_kind and p_source_id are required';
  END IF;
  SELECT c.workspace_id, c.channel_type, c.dm_user_a, c.dm_user_b INTO v_ch
    FROM public.chat_channels c WHERE c.channel_id = p_channel_id;
  IF v_ch.channel_type IS DISTINCT FROM 'dm' THEN RAISE EXCEPTION 'private reply needs a direct chat'; END IF;
  v_snap := public._private_reply_source(p_source_kind, p_source_id, v_actor, v_ch.workspace_id);
  IF v_snap IS NULL THEN RAISE EXCEPTION 'private reply source not accessible'; END IF;
  v_author := (v_snap->>'author_user_id')::uuid;
  IF v_author = v_actor OR NOT (v_actor IN (v_ch.dm_user_a, v_ch.dm_user_b) AND v_author IN (v_ch.dm_user_a, v_ch.dm_user_b)) THEN
    RAISE EXCEPTION 'private reply must go to the author';
  END IF;
  v_row := public.chat_message_send(p_id, p_channel_id, p_trace_id, p_body, p_mentions,
    p_attachment_asset_ids, NULL, NULL, p_attachment_meta, NULL, NULL);
  IF v_row.sender_user_id <> v_actor THEN RAISE EXCEPTION 'message id already used'; END IF;
  IF v_row.private_reply IS NULL THEN
    UPDATE public.chat_messages SET private_reply = v_snap WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END $function$;

REVOKE ALL ON FUNCTION public.chat_private_reply_send(uuid, text, uuid, text, text, text, jsonb, uuid[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_private_reply_send(uuid, text, uuid, text, text, text, jsonb, uuid[], jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_open_bundle(p_trace_id uuid, p_workspace_id uuid, p_channel_id text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  c_ts constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  c_cols constant text := 'm.id, m.channel_id, m.workspace_id, m.sender_user_id, m.body, m.mentions, m.attachment_asset_ids, m.shared_post_ids, m.shared_brief_ids, m.shared_plan_ids, m.reply_to_message_id, m.forwarded_from_message_id, m.attachment_meta, m.agora_event_id, m.created_at, m.edited_at, m.deleted_at, m.thread_root_message_id, m.removed_files, m.private_reply';
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
END $function$;

REVOKE ALL ON FUNCTION public.chat_open_bundle(uuid, uuid, text, timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_open_bundle(uuid, uuid, text, timestamp with time zone) TO authenticated;
