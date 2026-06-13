-- Already applied to live DB via MCP; committed retroactively. Do NOT re-execute manually.
--
-- public.chat_webhook_ingest: the single write path for the Agora chat
-- webhook-mirror Worker. SECURITY DEFINER, EXECUTE granted to service_role only.
-- It records every callback to webhook_events (deduped on (source,
-- source_event_id)), appends a webhook_processing_attempts row, and for message
-- events mirrors the message into chat_messages (deduped on (agora_event_id,
-- created_at)), nulling the sender when the user does not exist and returning
-- 'skipped' when the channel is unknown. This is a compliance mirror only and is
-- never on any chat read path. The chat_channels / chat_messages /
-- webhook_events / webhook_processing_attempts tables already exist from the
-- baseline migration, so this file is valid on a fresh CI database.

CREATE OR REPLACE FUNCTION public.chat_webhook_ingest(p_source_event_id text, p_event_type text, p_signature_verified boolean, p_raw_payload jsonb, p_channel_id text, p_message_id text, p_agora_event_id text, p_sender_user_id uuid, p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_created_at timestamp with time zone, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_event_id       uuid;
  v_workspace_id   uuid;
  v_sender         uuid;
  v_attempt        integer;
  v_outcome        text;
  v_error          text := NULL;
  v_message_stored boolean := false;
  v_is_message     boolean := p_agora_event_id IS NOT NULL;
  v_inserted       integer;
BEGIN
  IF p_channel_id IS NOT NULL THEN
    SELECT workspace_id INTO v_workspace_id
    FROM public.chat_channels WHERE channel_id = p_channel_id;
  END IF;

  INSERT INTO public.webhook_events
    (source, source_event_id, event_type, workspace_id, signature_verified, raw_payload)
  VALUES
    ('agora', p_source_event_id, p_event_type, v_workspace_id, p_signature_verified, p_raw_payload)
  ON CONFLICT (source, source_event_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT id INTO v_event_id FROM public.webhook_events
    WHERE source = 'agora' AND source_event_id = p_source_event_id;
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_attempt
  FROM public.webhook_processing_attempts WHERE webhook_event_id = v_event_id;

  IF v_is_message THEN
    IF p_message_id IS NULL OR p_created_at IS NULL THEN
      v_outcome := 'failure';
      v_error := 'message event missing message_id or created_at';
    ELSIF v_workspace_id IS NULL THEN
      v_outcome := 'skipped';
    ELSE
      v_sender := p_sender_user_id;
      IF v_sender IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_sender) THEN
        v_sender := NULL;
      END IF;

      INSERT INTO public.chat_messages
        (id, channel_id, workspace_id, sender_user_id, body, mentions,
         attachment_asset_ids, agora_event_id, created_at)
      VALUES
        (p_message_id, p_channel_id, v_workspace_id, v_sender, p_body, p_mentions,
         p_attachment_asset_ids, p_agora_event_id, p_created_at)
      ON CONFLICT (agora_event_id, created_at) DO NOTHING;

      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      v_message_stored := v_inserted > 0;
      v_outcome := 'success';
    END IF;
  ELSE
    v_outcome := 'success';
  END IF;

  INSERT INTO public.webhook_processing_attempts
    (webhook_event_id, attempt_number, started_at, finished_at, outcome, error, trace_id)
  VALUES
    (v_event_id, v_attempt, now(), now(), v_outcome, v_error, p_trace_id);

  RETURN jsonb_build_object(
    'webhook_event_id', v_event_id,
    'message_stored',   v_message_stored,
    'outcome',          v_outcome
  );
END;
$function$;

-- service_role-only EXECUTE: the worker connects as service_role; no browser
-- role may invoke this proc.
REVOKE ALL ON FUNCTION public.chat_webhook_ingest(text, text, boolean, jsonb, text, text, text, uuid, text, jsonb, uuid[], timestamptz, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_webhook_ingest(text, text, boolean, jsonb, text, text, text, uuid, text, jsonb, uuid[], timestamptz, uuid) TO service_role;
