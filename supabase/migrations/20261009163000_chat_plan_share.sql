-- Applied out of band 9 Oct 2026 (step 3a-ii chat plan share). No-op on movnexawfhsyuluspxoc.
--
-- chat_messages.shared_plan_ids (added on the partitioned parent, so every
-- partition including chat_messages_default inherits it); chat_plan_share (any
-- active member of the chat shares one plan: a client plan into any chat they
-- are in, a team plan only from the agency side and never into a chat with a
-- client member; idempotent on p_id; one audit_log row with by_client); and
-- chat_message_delete now also clears shared_plan_ids. Both functions are
-- copied verbatim from live (chat_plan_share as replaced 9 Oct 2026, 17:22 IST).

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS shared_plan_ids uuid[];

CREATE OR REPLACE FUNCTION public.chat_plan_share(p_id uuid, p_channel_id text, p_plan_id uuid, p_trace_id uuid, p_body text DEFAULT NULL::text)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_plan_ws uuid; v_aud text; v_agency boolean; v_row public.chat_messages;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_id is null or p_trace_id is null or p_plan_id is null then raise exception 'p_id, p_plan_id and p_trace_id are required'; end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id into v_ws from public.chat_channels where channel_id = p_channel_id;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  v_agency := public.is_agency_side_member(v_ws);
  select workspace_id, audience into v_plan_ws, v_aud from public.plans where id = p_plan_id and deleted_at is null;
  if v_plan_ws is null or v_plan_ws <> v_ws then raise exception 'plan not available'; end if;
  if v_aud = 'team' then
    if not v_agency then raise exception 'plan not available'; end if;
    if exists (select 1 from public.workspace_members wm
                where wm.workspace_id = v_ws and wm.active = true and wm.role = 'client'
                  and public.chat_channel_member(p_channel_id, wm.user_id)) then
      raise exception 'plan_not_shared_with_client';
    end if;
  end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  perform pg_advisory_xact_lock(hashtext(p_id::text));
  select * into v_row from public.chat_messages where id = p_id::text limit 1;
  if found then return v_row; end if;
  insert into public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, shared_plan_ids, agora_event_id, created_at)
  values (p_id::text, p_channel_id, v_ws, v_actor, nullif(btrim(p_body), ''), array[p_plan_id], null, now())
  returning * into v_row;
  perform public.audit_log_write(p_action=>'chat_plan_share', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text,
    p_payload=>jsonb_build_object('channel_id', p_channel_id, 'message_id', p_id::text, 'by_client', not v_agency));
  return v_row;
end $function$;

CREATE OR REPLACE FUNCTION public.chat_message_delete(p_message_ids text[], p_channel_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_blocked int; v_deleted int; v_notes boolean;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if coalesce(cardinality(p_message_ids), 0) = 0 or cardinality(p_message_ids) > 100 then raise exception 'select between 1 and 100 messages'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select c.channel_type = 'notes' into v_notes from public.chat_channels c where c.channel_id = p_channel_id;
  select count(*) into v_blocked from public.chat_message_marks where message_id = any(p_message_ids);
  if v_blocked > 0 then raise exception 'marked messages cannot be deleted'; end if;
  update public.chat_messages
     set deleted_at = now(), body = null, mentions = null, attachment_asset_ids = null,
         attachment_meta = null, shared_post_ids = null, shared_brief_ids = null, shared_plan_ids = null
   where id = any(p_message_ids) and channel_id = p_channel_id and sender_user_id = v_actor
     and deleted_at is null and (v_notes or created_at >= now() - interval '30 minutes');
  get diagnostics v_deleted = row_count;
  if v_deleted <> cardinality(p_message_ids) then raise exception 'only your own messages from the last 30 minutes can be deleted'; end if;
  update public.inbox_entries set deleted_at = now()
   where entity_type = 'chat_channel' and entity_id = p_channel_id and event_type = 'mention'
     and payload->>'message_id' = any(p_message_ids) and deleted_at is null;
end $function$;

-- Function privileges mirror live: EXECUTE to authenticated only.
REVOKE ALL ON FUNCTION public.chat_plan_share(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_plan_share(uuid, text, uuid, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.chat_message_delete(text[], text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_message_delete(text[], text, uuid) TO authenticated;
