-- Applied out of band 6 Nov 2026 (PR C, Bank meets Plan). No-op on movnexawfhsyuluspxoc.
--
-- chat_open_bundle: c_cols now lists m.shared_plan_item_ids (after
-- m.shared_plan_ids), so the open bundle's rows (page, quoted) carry an idea
-- message's ids and the client no longer reads them after paint.
-- plan_item_to_bank: the audit payload also logs target_date (the day the
-- concept sat on in the plan it left), so a moved-to-bank trace line sits on
-- that day. Both definitions are copied verbatim from live
-- (pg_get_functiondef, 6 Nov 2026). Grants are unchanged (CREATE OR REPLACE
-- keeps them).

CREATE OR REPLACE FUNCTION public.chat_open_bundle(p_trace_id uuid, p_workspace_id uuid, p_channel_id text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  c_ts constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  c_cols constant text := 'm.id, m.channel_id, m.workspace_id, m.sender_user_id, m.body, m.mentions, m.attachment_asset_ids, m.shared_post_ids, m.shared_brief_ids, m.shared_plan_ids, m.shared_plan_item_ids, m.reply_to_message_id, m.forwarded_from_message_id, m.attachment_meta, m.agora_event_id, m.created_at, m.edited_at, m.deleted_at, m.thread_root_message_id, m.removed_files, m.private_reply';
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

CREATE OR REPLACE FUNCTION public.plan_item_to_bank(p_item_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_plan uuid; v_kind text; v_linked uuid; v_title text; v_date date;
BEGIN
  SELECT workspace_id, plan_id, kind, linked_post_id, target_date INTO v_ws, v_plan, v_kind, v_linked, v_date
    FROM public.plan_items WHERE id = p_item_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL OR v_kind <> 'concept' OR v_plan IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_linked IS NOT NULL AND EXISTS (SELECT 1 FROM public.posts WHERE id = v_linked AND stage = 'approved')
    THEN RAISE EXCEPTION 'post_approved'; END IF;
  SELECT title INTO v_title FROM public.plans WHERE id = v_plan;
  UPDATE public.plan_items SET plan_id = NULL, target_date = NULL, came_from_plan_title = v_title,
    last_active_at = now(), updated_at = now() WHERE id = p_item_id;
  DELETE FROM public.plan_item_reviews WHERE item_id = p_item_id;
  PERFORM public.audit_log_write(p_action=>'plan_item_to_bank', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('from_plan_id', v_plan, 'target_date', v_date));
END $function$;
