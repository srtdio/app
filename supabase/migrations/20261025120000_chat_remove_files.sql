-- Chat: remove files, keep the message.
-- Adds chat_messages.removed_files (per-kind counts) and the
-- chat_message_remove_files proc (sender only, no voice notes, no marked messages).

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS removed_files jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.chat_message_remove_files(
  p_channel_id text, p_message_ids text[], p_asset_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid(); v_owned int; m record;
  v_left uuid[]; v_meta jsonb; v_rm jsonb; v_kind text; a uuid;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if coalesce(cardinality(p_asset_ids), 0) = 0 or cardinality(p_asset_ids) > 100
     or coalesce(cardinality(p_message_ids), 0) = 0 then
    raise exception 'select between 1 and 100 files'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  if exists (select 1 from public.chat_message_marks where message_id = any(p_message_ids)) then
    raise exception 'only your own files can be removed'; end if;
  select count(*) into v_owned from unnest(p_asset_ids) x(id)
   where exists (
     select 1 from public.chat_messages cm
      where cm.id = any(p_message_ids) and cm.channel_id = p_channel_id
        and cm.sender_user_id = v_actor and cm.deleted_at is null
        and x.id = any(cm.attachment_asset_ids)
        and coalesce(cm.attachment_meta -> (x.id::text) ->> 'mime', '') not like 'audio/%');
  if v_owned <> cardinality(p_asset_ids) then raise exception 'only your own files can be removed'; end if;
  update public.assets set deleted_at = coalesce(deleted_at, now()), purge_requested_at = now()
   where origin = 'chat' and id = any(p_asset_ids);
  for m in
    select * from public.chat_messages
     where id = any(p_message_ids) and channel_id = p_channel_id and sender_user_id = v_actor
       and deleted_at is null and attachment_asset_ids && p_asset_ids
     for update
  loop
    v_left := array(select u.x from unnest(m.attachment_asset_ids) with ordinality u(x, o)
                     where u.x <> all(p_asset_ids) order by u.o);
    v_meta := coalesce(m.attachment_meta, '{}'::jsonb);
    v_rm := coalesce(m.removed_files, '{}'::jsonb);
    foreach a in array m.attachment_asset_ids loop
      if a = any(p_asset_ids) then
        v_kind := case when v_meta -> (a::text) ->> 'mime' like 'image/%' then 'photo'
                       when v_meta -> (a::text) ->> 'mime' like 'video/%' then 'video'
                       else 'file' end;
        v_rm := jsonb_set(v_rm, array[v_kind], to_jsonb(coalesce((v_rm ->> v_kind)::int, 0) + 1));
        v_meta := v_meta - (a::text);
      end if;
    end loop;
    if cardinality(v_left) = 0 and nullif(btrim(coalesce(m.body, '')), '') is null
       and coalesce(cardinality(m.shared_post_ids), 0) = 0
       and coalesce(cardinality(m.shared_brief_ids), 0) = 0
       and coalesce(cardinality(m.shared_plan_ids), 0) = 0 then
      update public.chat_messages
         set deleted_at = now(), body = null, mentions = null, attachment_asset_ids = null,
             attachment_meta = null, shared_post_ids = null, shared_brief_ids = null, shared_plan_ids = null
       where id = m.id;
    else
      update public.chat_messages
         set attachment_asset_ids = case when cardinality(v_left) = 0 then null else v_left end,
             attachment_meta = case when v_meta = '{}'::jsonb then null else v_meta end,
             removed_files = v_rm
       where id = m.id;
    end if;
  end loop;
end $function$;

REVOKE ALL ON FUNCTION public.chat_message_remove_files(text, text[], uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_message_remove_files(text, text[], uuid[], uuid) TO authenticated;
