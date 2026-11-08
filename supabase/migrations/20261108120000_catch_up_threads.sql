-- Record of objects applied to movnexawfhsyuluspxoc on 2026-11-08 (verified). Do NOT run supabase db push.
-- chat_message_send: mention payload carries thread_root_id; the first reply on a card root (post, brief, plan, idea)
--   writes one system/thread_started inbox entry per chat member except the sender and the mentioned.
-- inbox_mark_unread_ids: catch-up Undo puts read entries back to unread (caller's rows only).
create or replace function public.chat_message_send(p_id uuid, p_channel_id text, p_trace_id uuid, p_body text default null::text, p_mentions jsonb default null::jsonb, p_attachment_asset_ids uuid[] default null::uuid[], p_shared_post_ids uuid[] default null::uuid[], p_reply_to_message_id text default null::text, p_attachment_meta jsonb default null::jsonb, p_shared_brief_ids uuid[] default null::uuid[], p_forwarded_from_message_id text default null::text)
 returns chat_messages language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := auth.uid(); v_workspace_id uuid; v_channel_type text;
  v_src_channel text; v_src_workspace uuid; v_mentioned uuid[]; v_row public.chat_messages;
  v_root public.chat_messages; v_card_kind text; v_card_id text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_id is null or p_trace_id is null then raise exception 'p_id and p_trace_id are required'; end if;
  if coalesce(length(btrim(p_body)), 0) = 0 and coalesce(cardinality(p_attachment_asset_ids), 0) = 0
     and coalesce(cardinality(p_shared_post_ids), 0) = 0 and coalesce(cardinality(p_shared_brief_ids), 0) = 0 then
    raise exception 'message has no body, attachments, shared posts or shared briefs';
  end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id, channel_type into v_workspace_id, v_channel_type from public.chat_channels where channel_id = p_channel_id;
  if coalesce(cardinality(p_attachment_asset_ids), 0) > 0 and exists (
    select 1 from unnest(p_attachment_asset_ids) vid
    where not exists (
      select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
      where v.id = vid and v.workspace_id = v_workspace_id
        and (a.origin = 'library' or public.chat_attachment_readable(vid, v_actor)))) then
    raise exception 'attachment not available';
  end if;
  if p_reply_to_message_id is not null and not exists (
    select 1 from public.chat_messages m where m.id = p_reply_to_message_id and m.channel_id = p_channel_id) then
    raise exception 'reply target not in this chat';
  end if;
  if p_forwarded_from_message_id is not null then
    select channel_id, workspace_id into v_src_channel, v_src_workspace
      from public.chat_messages where id = p_forwarded_from_message_id and deleted_at is null limit 1;
    if v_src_channel is null or v_src_workspace <> v_workspace_id or not public.chat_channel_member(v_src_channel, v_actor) then
      raise exception 'forward source not accessible';
    end if;
  end if;
  v_mentioned := public.chat_mentions_resolve(p_channel_id, v_actor, p_mentions);
  perform pg_advisory_xact_lock(hashtext(p_id::text));
  select * into v_row from public.chat_messages where id = p_id::text limit 1;
  if found then return v_row; end if;
  insert into public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids,
    shared_post_ids, reply_to_message_id, attachment_meta, shared_brief_ids, forwarded_from_message_id, agora_event_id, created_at)
  values (p_id::text, p_channel_id, v_workspace_id, v_actor, p_body,
    case when cardinality(v_mentioned) > 0 then to_jsonb(v_mentioned) end, p_attachment_asset_ids,
    p_shared_post_ids, p_reply_to_message_id, p_attachment_meta, p_shared_brief_ids, p_forwarded_from_message_id, null, now())
  returning * into v_row;
  if cardinality(v_mentioned) > 0 then
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select u, v_workspace_id, 'mention', 'chat_channel', p_channel_id,
           case when v_channel_type = 'dm' then 'people' else 'groups' end, p_channel_id, 'urgent',
           jsonb_strip_nulls(jsonb_build_object('message_id', p_id::text, 'thread_root_id', v_row.thread_root_message_id)), v_actor
    from unnest(v_mentioned) u;
  end if;
  if v_row.thread_root_message_id is not null then
    perform pg_advisory_xact_lock(hashtext('thread:' || v_row.thread_root_message_id));
    if not exists (select 1 from public.chat_messages x
                    where x.channel_id = p_channel_id and x.thread_root_message_id = v_row.thread_root_message_id
                      and x.id <> v_row.id) then
      select * into v_root from public.chat_messages
       where id = v_row.thread_root_message_id and channel_id = p_channel_id and deleted_at is null limit 1;
      if found then
        v_card_kind := case when coalesce(cardinality(v_root.shared_post_ids), 0) > 0 then 'post'
                            when coalesce(cardinality(v_root.shared_brief_ids), 0) > 0 then 'brief'
                            when coalesce(cardinality(v_root.shared_plan_ids), 0) > 0 then 'plan'
                            when coalesce(cardinality(v_root.shared_plan_item_ids), 0) > 0 then 'item' end;
        v_card_id := case v_card_kind when 'post' then v_root.shared_post_ids[1]::text
                                      when 'brief' then v_root.shared_brief_ids[1]::text
                                      when 'plan' then v_root.shared_plan_ids[1]::text
                                      when 'item' then v_root.shared_plan_item_ids[1]::text end;
        if v_card_kind is not null then
          insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
          select wm.user_id, v_workspace_id, 'system', 'chat_channel', p_channel_id,
                 case when v_channel_type = 'dm' then 'people' else 'groups' end, p_channel_id, 'active',
                 jsonb_build_object('kind', 'thread_started', 'message_id', p_id::text, 'thread_root_id', v_row.thread_root_message_id,
                                    'card_kind', v_card_kind, 'card_id', v_card_id), v_actor
            from public.workspace_members wm
           where wm.workspace_id = v_workspace_id and wm.active = true
             and wm.user_id <> v_actor
             and not (wm.user_id = any (coalesce(v_mentioned, array[]::uuid[])))
             and public.chat_channel_member(p_channel_id, wm.user_id);
        end if;
      end if;
    end if;
  end if;
  return v_row;
end $function$;

create or replace function public.inbox_mark_unread_ids(p_workspace_id uuid, p_ids uuid[], p_trace_id uuid)
 returns void language plpgsql security definer set search_path to ''
as $function$
declare v_n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(p_workspace_id) then raise exception 'workspace_member_only'; end if;
  update public.inbox_entries set read_at = null
   where workspace_id = p_workspace_id and user_id = auth.uid() and id = any(p_ids)
     and read_at is not null and deleted_at is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit_log_write('inbox_mark_unread_ids','success',p_trace_id,p_workspace_id,'inbox_entry',null::text,jsonb_build_object('count',v_n));
  end if;
end $function$;
revoke all on function public.inbox_mark_unread_ids(uuid, uuid[], uuid) from public, anon;
grant execute on function public.inbox_mark_unread_ids(uuid, uuid[], uuid) to authenticated;
