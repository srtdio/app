-- Record of changes already applied to the live database via MCP (latest: 2026-07-10).
-- Idempotent. Safe under db push. Do NOT re-apply manually.
-- Contents: post_versions.last_edited_at; chat_message_save; ensure_future_partitions;
-- member_remove; post_version_create (15-min fold, supersedes 20260613092000 version);
-- ensure-future-partitions cron job.

ALTER TABLE public.post_versions ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;

CREATE OR REPLACE FUNCTION public.chat_message_save(p_channel_id text, p_agora_message_id text, p_created_at timestamp with time zone, p_body text DEFAULT NULL::text, p_mentions jsonb DEFAULT NULL::jsonb, p_attachment_asset_ids uuid[] DEFAULT NULL::uuid[], p_trace_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);

  SELECT workspace_id INTO v_workspace_id
  FROM public.chat_channels
  WHERE channel_id = p_channel_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'chat channel not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = v_workspace_id
      AND wm.user_id = v_actor
      AND wm.active = true
  ) THEN
    RAISE EXCEPTION 'not an active member of this workspace';
  END IF;

  INSERT INTO public.chat_messages
    (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids, agora_event_id, created_at)
  VALUES
    (p_agora_message_id, p_channel_id, v_workspace_id, v_actor, p_body, p_mentions, p_attachment_asset_ids, p_agora_message_id, p_created_at)
  ON CONFLICT (id, created_at) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.chat_message_save(text, text, timestamp with time zone, text, jsonb, uuid[], uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.chat_message_save(text, text, timestamp with time zone, text, jsonb, uuid[], uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ensure_future_partitions(p_months integer DEFAULT 3)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tables text[] := ARRAY['chat_messages','inbox_entries','audit_log'];
  v_tbl text;
  v_start date;
  v_end date;
  v_part text;
  i integer;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    FOR i IN 0..p_months LOOP
      v_start := (date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i))::date;
      v_end := (v_start + interval '1 month')::date;
      v_part := format('%s_%s', v_tbl, to_char(v_start, 'YYYY_MM'));
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        v_part, v_tbl, v_start::timestamptz, v_end::timestamptz
      );
    END LOOP;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_future_partitions(integer) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.member_remove(p_member_id uuid, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ws uuid;
  v_user uuid;
  v_role text;
  v_removed_at timestamptz;
  v_was_active boolean;
BEGIN
  SELECT workspace_id, user_id, role, removed_at, active
  INTO v_ws, v_user, v_role, v_removed_at, v_was_active
  FROM public.workspace_members
  WHERE id = p_member_id;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF NOT public.is_active_workspace_member(v_ws) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF NOT public.proc_capability(v_ws, 'workspace.manage_members') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF v_user = auth.uid() THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF v_removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  UPDATE public.workspace_members
  SET active = false, removed_at = now()
  WHERE id = p_member_id;

  DELETE FROM public.group_members
  WHERE workspace_id = v_ws AND user_id = v_user;

  PERFORM public.audit_log_write(
    p_action => 'member_remove', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => v_ws, p_entity_type => 'workspace_member', p_entity_id => p_member_id::text,
    p_payload => jsonb_build_object('role', v_role, 'was_active', v_was_active));
  RETURN p_member_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.member_remove(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.member_remove(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_version_create(p_post_id uuid, p_snapshot jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c_window constant interval := interval '15 minutes';
  v_ws uuid;
  v_stage_entered timestamptz;
  v_last record;
  v_n integer;
  v_id uuid;
BEGIN
  SELECT workspace_id, stage_entered_at INTO v_ws, v_stage_entered
  FROM public.posts WHERE id = p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN RAISE EXCEPTION 'invalid_payload'; END IF;

  SELECT id, created_by, created_at, last_edited_at, version_number
  INTO v_last
  FROM public.post_versions
  WHERE post_id = p_post_id
  ORDER BY version_number DESC
  LIMIT 1;

  IF v_last.id IS NOT NULL
     AND v_last.created_by IS NOT NULL
     AND v_last.created_by = auth.uid()
     AND now() - coalesce(v_last.last_edited_at, v_last.created_at) < c_window
     AND v_stage_entered IS NOT NULL
     AND v_stage_entered <= v_last.created_at
     AND NOT EXISTS (SELECT 1 FROM public.post_annotations a WHERE a.post_version_id = v_last.id)
  THEN
    UPDATE public.post_versions
    SET snapshot = p_snapshot, last_edited_at = now()
    WHERE id = v_last.id;
    PERFORM public.audit_log_write('post_version_create','success',p_trace_id,v_ws,'post_version',v_last.id::text,
            jsonb_build_object('post_id',p_post_id,'version_number',v_last.version_number,'folded',true));
    RETURN v_last.id;
  END IF;

  SELECT coalesce(max(version_number),0) + 1 INTO v_n FROM public.post_versions WHERE post_id = p_post_id;
  INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
  VALUES (p_post_id, v_ws, v_n, p_snapshot, auth.uid()) RETURNING id INTO v_id;
  PERFORM public.audit_log_write('post_version_create','success',p_trace_id,v_ws,'post_version',v_id::text,
          jsonb_build_object('post_id',p_post_id,'version_number',v_n,'folded',false));
  RETURN v_id;
END; $function$;

REVOKE ALL ON FUNCTION public.post_version_create(uuid, jsonb, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.post_version_create(uuid, jsonb, uuid) TO authenticated;

DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ensure-future-partitions') THEN
      PERFORM cron.schedule('ensure-future-partitions', '0 3 1 * *', 'SELECT public.ensure_future_partitions(3)');
    END IF;
  END IF;
END $$;
