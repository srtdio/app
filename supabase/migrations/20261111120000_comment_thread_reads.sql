-- Record of objects applied to movnexawfhsyuluspxoc on 11 Nov 2026 (verified).
-- Read back verbatim from the live database (pg_get_functiondef, information_schema).
-- Comment threads: per-thread read points for post and brief comment threads, and
-- Approver (client role) plain top-level comments on non-draft posts.
-- The table is written only through the SECURITY DEFINER proc below; authenticated
-- may SELECT its own rows (comment_thread_reads_own).

create table if not exists public.comment_thread_reads (
  root_comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (root_comment_id, user_id)
);

create index if not exists comment_thread_reads_user
  on public.comment_thread_reads using btree (user_id);

alter table public.comment_thread_reads enable row level security;

drop policy if exists comment_thread_reads_own on public.comment_thread_reads;
create policy comment_thread_reads_own on public.comment_thread_reads
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.comment_thread_reads from anon, authenticated;
grant select on public.comment_thread_reads to authenticated;

CREATE OR REPLACE FUNCTION public.comment_thread_read_set(p_root_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_at timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  select c.workspace_id into v_ws from public.comments c
   where c.id = p_root_id and c.parent_comment_id is null
     and exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = c.workspace_id and wm.user_id = v_actor and wm.active = true);
  if v_ws is null then raise exception 'comment not found'; end if;
  select max(r.created_at) into v_at from public.comments r
   where r.id = p_root_id or r.parent_comment_id = p_root_id;
  insert into public.comment_thread_reads (root_comment_id, user_id, workspace_id, last_read_at)
  values (p_root_id, v_actor, v_ws, v_at)
  on conflict (root_comment_id, user_id) do update
    set last_read_at = excluded.last_read_at, updated_at = now()
    where excluded.last_read_at > public.comment_thread_reads.last_read_at;
end $function$
;

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
         AND wm.active = true AND wm.role = 'client')
     AND EXISTS (SELECT 1 FROM public.posts dp WHERE dp.id = p_entity_id
                  AND dp.workspace_id = p_workspace_id AND dp.stage = 'draft') THEN
    RAISE EXCEPTION 'invalid_stage';
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

revoke all on function public.comment_thread_read_set(uuid, uuid) from public, anon;
grant execute on function public.comment_thread_read_set(uuid, uuid) to authenticated;
revoke all on function public.comment_create(uuid, text, uuid, uuid, text, jsonb, uuid[], uuid) from public, anon;
grant execute on function public.comment_create(uuid, text, uuid, uuid, text, jsonb, uuid[], uuid) to authenticated;

-- One-time backfill (live: 2348 rows, 480 threads): every active member starts with a
-- read row for every top-level comment that already had replies, so old threads are
-- not unread. A no-op on an empty database; re-running never moves a read point.
insert into public.comment_thread_reads (root_comment_id, user_id, workspace_id, last_read_at)
select c.id, wm.user_id, c.workspace_id, now()
from public.comments c
join public.workspace_members wm
  on wm.workspace_id = c.workspace_id and wm.active = true
where c.parent_comment_id is null
  and exists (select 1 from public.comments r where r.parent_comment_id = c.id)
on conflict do nothing;
