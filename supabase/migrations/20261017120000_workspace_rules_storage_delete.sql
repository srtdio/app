-- Workspace rules: storage, delete guards, purge list.
-- Already applied live on 17 Oct 2026 via the SQL editor; this file is the record.
-- Function bodies are pg_get_functiondef output from v2 (movnexawfhsyuluspxoc). Idempotent.

-- Column + index
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS purge_requested_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS assets_deleted_at_idx ON public.assets USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);

-- Functions
CREATE OR REPLACE FUNCTION public.workspace_bytes_used(p_workspace_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select sum(size_bytes) from public.asset_versions where workspace_id = p_workspace_id),0)::bigint
       + coalesce((select sum(size_bytes) from public.asset_renditions where workspace_id = p_workspace_id),0)::bigint;
$function$
;

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
  where v.workspace_id = p_workspace_id and public.is_active_workspace_member(p_workspace_id);
$function$
;

CREATE OR REPLACE FUNCTION public.asset_in_use(p_asset_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.asset_attachments aa
    where aa.asset_id = p_asset_id and aa.deleted_at is null
      and (
        (aa.entity_type = 'post'    and exists (select 1 from public.posts x    where x.id::text = aa.entity_id and x.deleted_at is null))
     or (aa.entity_type = 'brief'   and exists (select 1 from public.briefs x   where x.id::text = aa.entity_id and x.deleted_at is null))
     or (aa.entity_type = 'comment' and exists (select 1 from public.comments x where x.id::text = aa.entity_id and x.deleted_at is null))
      ));
$function$
;

CREATE OR REPLACE FUNCTION public.asset_delete(p_asset_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_name text; v_role text;
BEGIN
  SELECT workspace_id INTO v_ws
    FROM public.assets WHERE id = p_asset_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF public.asset_in_use(p_asset_id) THEN RAISE EXCEPTION 'asset_in_use'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;
  UPDATE public.assets SET deleted_at = now() WHERE id = p_asset_id RETURNING filename INTO v_name;
  PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',p_asset_id::text);
  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid() AND wm.active = true;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text, 'active',
         jsonb_build_object('count', 1, 'filenames', jsonb_build_array(v_name), 'actor_role', v_role), auth.uid()
    FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
END; $function$
;

CREATE OR REPLACE FUNCTION public.asset_delete_many(p_asset_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ws uuid;
  v_distinct integer;
  v_id uuid;
  v_ids uuid[];
  v_names text[];
  v_role text;
BEGIN
  IF p_asset_ids IS NULL OR array_length(p_asset_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF array_length(p_asset_ids, 1) > 200 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT count(DISTINCT workspace_id), (array_agg(DISTINCT workspace_id))[1]
    INTO v_distinct, v_ws
    FROM public.assets
    WHERE id = ANY(p_asset_ids) AND deleted_at IS NULL;

  IF v_ws IS NULL OR v_distinct <> 1 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets
             WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_asset_ids) x(id) WHERE public.asset_in_use(x.id)) THEN RAISE EXCEPTION 'asset_in_use'; END IF;

  WITH deleted AS (
    UPDATE public.assets SET deleted_at = now()
      WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL
      RETURNING id, filename
  )
  SELECT array_agg(id), (array_agg(filename ORDER BY filename))[1:3]
    INTO v_ids, v_names
    FROM deleted;

  IF v_ids IS NULL THEN RETURN; END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',v_id::text);
  END LOOP;

  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid() AND wm.active = true;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text, 'active',
         jsonb_build_object('count', cardinality(v_ids), 'filenames', to_jsonb(v_names), 'actor_role', v_role), auth.uid()
    FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
END; $function$
;

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
  update public.assets set deleted_at = coalesce(deleted_at, now()), purge_requested_at = now()
   where origin = 'chat' and id in (
     select unnest(m.attachment_asset_ids) from public.chat_messages m
      where m.id = any(p_message_ids) and m.channel_id = p_channel_id and m.sender_user_id = v_actor
        and m.deleted_at is null and (v_notes or m.created_at >= now() - interval '30 minutes'));
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
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_restore(p_asset_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.assets
   where id = p_asset_id and deleted_at is not null and purge_requested_at is null and origin = 'library';
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  update public.assets set deleted_at = null where id = p_asset_id;
  perform public.audit_log_write('asset_restore','success',p_trace_id,v_ws,'asset',p_asset_id::text);
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_purge_request(p_workspace_id uuid, p_asset_ids uuid[], p_trace_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if not exists (select 1 from public.workspaces where id = p_workspace_id and owner_user_id = auth.uid() and deleted_at is null)
    then raise exception 'owner_only'; end if;
  update public.assets set purge_requested_at = now()
   where workspace_id = p_workspace_id and origin = 'library' and deleted_at is not null and purge_requested_at is null
     and (p_asset_ids is null or id = any(p_asset_ids));
  get diagnostics v_n = row_count;
  perform public.audit_log_write('asset_purge_request','success',p_trace_id,p_workspace_id,'workspace',p_workspace_id::text);
  return v_n;
end $function$
;

CREATE OR REPLACE FUNCTION public.workspace_delete(p_workspace_id uuid, p_confirm_name text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_name text;
begin
  select name into v_name from public.workspaces
   where id = p_workspace_id and owner_user_id = auth.uid() and deleted_at is null
   for update;
  if v_name is null then raise exception 'owner_only'; end if;
  if p_confirm_name is distinct from v_name then raise exception 'confirm_name_mismatch'; end if;
  update public.workspaces set deleted_at = now() where id = p_workspace_id;
  update public.workspace_members set active = false where workspace_id = p_workspace_id and active = true;
  perform public.audit_log_write('workspace_delete','success',p_trace_id,p_workspace_id,'workspace',p_workspace_id::text);
end $function$
;

CREATE OR REPLACE FUNCTION public.storage_purge_due(p_limit integer)
 RETURNS TABLE(asset_id uuid, workspace_id uuid, bucket text, r2_keys text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.id, a.workspace_id, w.asset_bucket,
         array(select v.r2_key from public.asset_versions v where v.asset_id = a.id and v.r2_key is not null
               union all
               select r.r2_key from public.asset_renditions r join public.asset_versions v2 on v2.id = r.asset_version_id
                where v2.asset_id = a.id and r.r2_key is not null)
    from public.assets a join public.workspaces w on w.id = a.workspace_id
   where a.deleted_at is not null
     and (a.purge_requested_at is not null or a.deleted_at < now() - interval '31 days')
     and not public.asset_in_use(a.id)
   order by coalesce(a.purge_requested_at, a.deleted_at)
   limit greatest(1, least(coalesce(p_limit,100), 1000));
$function$
;

CREATE OR REPLACE FUNCTION public.storage_purge_done(p_asset_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ids uuid[]; v_n integer;
begin
  select array_agg(a.id) into v_ids from public.assets a
   where a.id = any(p_asset_ids) and a.deleted_at is not null
     and (a.purge_requested_at is not null or a.deleted_at < now() - interval '31 days')
     and not public.asset_in_use(a.id);
  if v_ids is null then return 0; end if;
  delete from public.asset_attachments where asset_id = any(v_ids);
  delete from public.assets where id = any(v_ids);
  get diagnostics v_n = row_count;
  return v_n;
end $function$
;

CREATE OR REPLACE FUNCTION public.workspace_purge_due()
 RETURNS TABLE(workspace_id uuid, bucket text, deleted_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select id, asset_bucket, deleted_at from public.workspaces where deleted_at is not null order by deleted_at limit 50;
$function$
;

CREATE OR REPLACE FUNCTION public.workspace_purge_done(p_workspace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from public.workspaces where id = p_workspace_id and deleted_at is not null) then
    raise exception 'not_deleted'; end if;
  delete from public.asset_attachments where workspace_id = p_workspace_id;
  delete from public.assets where workspace_id = p_workspace_id;
  delete from public.folders where workspace_id = p_workspace_id;
  -- A6 extras: comments.resolved_version_id -> post_versions and posts.bucket_id -> workspace_buckets are NO ACTION
  delete from public.comments where workspace_id = p_workspace_id;
  delete from public.posts where workspace_id = p_workspace_id;
  delete from public.workspaces where id = p_workspace_id;
end $function$
;

-- Grants (live ACL: EXECUTE only where granted below)
REVOKE ALL ON FUNCTION public.workspace_bytes_used(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.workspace_storage(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.asset_in_use(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.asset_delete(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.asset_delete_many(uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_message_delete(text[], text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.asset_restore(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.asset_purge_request(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.workspace_delete(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.storage_purge_due(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.storage_purge_done(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.workspace_purge_due() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.workspace_purge_done(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.workspace_storage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_delete(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_delete_many(uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_message_delete(text[], text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_restore(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_purge_request(uuid, uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_delete(uuid, text, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.workspace_bytes_used(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.storage_purge_due(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.storage_purge_done(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_purge_due() TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_purge_done(uuid) TO service_role;

-- Policy: members see soft-deleted library files (Recently deleted) until a purge is requested
DROP POLICY IF EXISTS assets_select_deleted_member ON public.assets;
CREATE POLICY assets_select_deleted_member ON public.assets
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NOT NULL) AND (origin = 'library'::text) AND (purge_requested_at IS NULL) AND public.is_active_workspace_member(workspace_id)));
