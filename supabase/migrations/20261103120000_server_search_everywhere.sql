-- Server search everywhere (v2). Already applied to the live database; this file
-- reproduces it from pg_indexes.indexdef and pg_get_functiondef. No DROP, no data writes.

-- The trigram indexes need pg_trgm. Live has it (1.6) in schema public but no
-- earlier migration creates it, so a fresh local database lacked gin_trgm_ops.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS posts_ws_created_id_idx ON public.posts USING btree (workspace_id, created_at DESC, id DESC) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS comments_ledger_batch_idx ON public.comments USING btree (ledger_batch_id) WHERE (ledger_batch_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS assets_filename_trgm_idx ON public.assets USING gin (filename gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS assets_display_name_trgm_idx ON public.assets USING gin (display_name gin_trgm_ops) WHERE ((deleted_at IS NULL) AND (display_name IS NOT NULL));

CREATE OR REPLACE FUNCTION public.activity_search_matches(p_workspace_id uuid, p_query text)
 RETURNS SETOF inbox_entries
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with q as (
  select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as lk
  where length(trim(coalesce(p_query, ''))) between 2 and 100
),
mine as materialized (
  select e.* from public.inbox_entries e
  where e.workspace_id = p_workspace_id
    and e.user_id = (select auth.uid())
    and e.deleted_at is null
    and exists (select 1 from q)
),
ref as materialized (
  select
    array_agg(distinct (e.payload->>'comment_id')::uuid)
      filter (where e.entity_type in ('post', 'brief')
                and e.payload->>'comment_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as comment_ids,
    array_agg(distinct (e.payload->>'batch_id')::uuid)
      filter (where e.event_type = 'checkpoints_added'
                and e.payload->>'batch_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as batch_ids,
    array_agg(distinct (e.payload->>'comment_id')::uuid)
      filter (where e.entity_type = 'plan_item'
                and e.payload->>'comment_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as plan_comment_ids,
    array_agg(distinct e.payload->>'message_id')
      filter (where e.entity_type = 'chat_channel' and e.payload ? 'message_id') as message_ids
  from mine e
),
hit_users as (
  select u.id
  from public.users u
  join public.workspace_members wm on wm.user_id = u.id and wm.workspace_id = p_workspace_id
  cross join q
  where u.display_name ilike q.lk or u.username ilike q.lk
),
hit_posts as (
  select p.id::text as id from public.posts p cross join q
  where p.workspace_id = p_workspace_id and p.deleted_at is null
    and (p.title ilike q.lk or p.caption ilike q.lk)
),
hit_briefs as (
  select b.id::text as id from public.briefs b cross join q
  where b.workspace_id = p_workspace_id and b.deleted_at is null
    and (b.title ilike q.lk or b.objective ilike q.lk)
),
hit_plans as (
  select pl.id::text as id from public.plans pl cross join q
  where pl.workspace_id = p_workspace_id and pl.deleted_at is null and pl.title ilike q.lk
),
hit_items as (
  select i.id::text as id
  from public.plan_items i
  cross join q
  left join public.posts po on po.id = i.post_id and po.deleted_at is null
  where i.workspace_id = p_workspace_id and i.deleted_at is null
    and (i.title ilike q.lk or i.description ilike q.lk or po.title ilike q.lk or po.caption ilike q.lk)
),
hit_comments as (
  select c.id::text as id, c.ledger_batch_id::text as batch_id
  from public.comments c cross join q cross join ref
  where c.workspace_id = p_workspace_id and c.deleted_at is null
    and (c.id = any (ref.comment_ids) or c.ledger_batch_id = any (ref.batch_ids))
    and c.body ilike q.lk
),
hit_plan_comments as (
  select pc.id::text as id
  from public.plan_item_comments pc cross join q cross join ref
  where pc.id = any (ref.plan_comment_ids)
    and pc.workspace_id = p_workspace_id and pc.deleted_at is null
    and pc.body ilike q.lk
),
hit_messages as (
  select m.id
  from public.chat_messages m cross join q cross join ref
  where m.id = any (ref.message_ids)
    and m.workspace_id = p_workspace_id and m.deleted_at is null
    and m.body ilike q.lk
)
select e.*
from mine e cross join q
where e.actor_user_id in (select id from hit_users)
   or e.payload->>'title' ilike q.lk
   or e.payload->>'post_title' ilike q.lk
   or e.payload->>'plan_title' ilike q.lk
   or e.payload->>'brief_title' ilike q.lk
   or e.payload->>'workspace_name' ilike q.lk
   or (e.event_type = 'task_changed' and (e.payload->>'new' ilike q.lk or e.payload->>'old' ilike q.lk))
   or (e.event_type = 'assets_deleted' and (e.payload->'filenames')::text ilike q.lk)
   or (e.entity_type = 'post'
       and (e.entity_id in (select id from hit_posts) or e.payload->>'brief_id' in (select id from hit_briefs)))
   or (e.entity_type = 'brief' and e.entity_id in (select id from hit_briefs))
   or (e.entity_type = 'plan'
       and (e.entity_id in (select id from hit_plans)
            or e.payload->>'item_id' in (select id from hit_items)
            or e.payload->>'post_id' in (select id from hit_posts)))
   or (e.entity_type = 'plan_item'
       and (e.entity_id in (select id from hit_items)
            or e.payload->>'plan_id' in (select id from hit_plans)
            or e.payload->>'comment_id' in (select id from hit_plan_comments)))
   or (e.entity_type in ('post', 'brief') and e.payload->>'comment_id' in (select id from hit_comments))
   or (e.event_type = 'checkpoints_added'
       and e.payload->>'batch_id' in (select batch_id from hit_comments where batch_id is not null))
   or (e.entity_type = 'chat_channel' and e.payload->>'message_id' in (select id from hit_messages));
$function$
;

CREATE OR REPLACE FUNCTION public.activity_search(p_workspace_id uuid, p_query text, p_trace_id uuid, p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS SETOF inbox_entries
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select e.*
  from public.activity_search_matches(p_workspace_id, p_query) e
  where p_before_created_at is null
     or e.created_at < p_before_created_at
     or (e.created_at = p_before_created_at and p_before_id is not null and e.id < p_before_id)
  order by e.created_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$function$
;

CREATE OR REPLACE FUNCTION public.workspace_search_matches(p_workspace_id uuid, p_query text)
 RETURNS TABLE(kind text, id uuid, parent_id uuid, channel_id text, entity_type text, number integer, title text, body text, actor uuid, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
with q as (
  select
    (select string_agg('''' || t || ''':*', ' & ')
       from regexp_split_to_table(lower(regexp_replace(p_query,
            '[&|!():*<>''"\\]', ' ', 'g')), '\s+') t where length(t) > 0) as ts,
    '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as lk
  where length(trim(coalesce(p_query, ''))) between 2 and 100
)
select 'post', p.id, null::uuid, null::text, 'post', p.number, p.title, p.caption, p.created_by, p.created_at
from posts p, q where p.workspace_id = p_workspace_id and p.deleted_at is null
  and to_tsvector('english', (coalesce(p.title,'') || ' ') || coalesce(p.caption,'')) @@ to_tsquery('english', q.ts)
union all
select 'brief', b.id, null, null, 'brief', b.number, b.title, b.objective, b.created_by, b.created_at
from briefs b, q where b.workspace_id = p_workspace_id and b.deleted_at is null
  and to_tsvector('english', (b.title || ' ') || b.objective) @@ to_tsquery('english', q.ts)
union all
select 'comment', c.id, c.entity_id, null, c.entity_type, coalesce(p.number, b.number),
       coalesce(p.title, b.title), c.body, c.author_user_id, c.created_at
from comments c cross join q
left join posts p on c.entity_type = 'post' and p.id = c.entity_id and p.deleted_at is null
left join briefs b on c.entity_type = 'brief' and b.id = c.entity_id and b.deleted_at is null
where c.workspace_id = p_workspace_id and c.deleted_at is null
  and c.entity_type in ('post','brief') and (p.id is not null or b.id is not null)
  and to_tsvector('english', c.body) @@ to_tsquery('english', q.ts)
union all
select 'person', u.id, null, null, 'user', null, u.display_name, u.username, u.id, wm.accepted_at
from workspace_members wm join users u on u.id = wm.user_id, q
where wm.workspace_id = p_workspace_id and wm.active and wm.removed_at is null and u.deleted_at is null
  and (u.display_name ilike q.lk or u.username ilike q.lk)
union all
select 'file', a.id, null, null, 'asset', null, coalesce(a.display_name, a.filename), a.folder_path, a.uploaded_by, a.uploaded_at
from assets a, q where a.workspace_id = p_workspace_id and a.deleted_at is null
  and (a.filename ilike q.lk or a.display_name ilike q.lk)
union all
select 'plan', pl.id, null, null, 'plan', null, pl.title, null, pl.created_by, pl.created_at
from plans pl, q where pl.workspace_id = p_workspace_id and pl.deleted_at is null and pl.title ilike q.lk
union all
select 'plan_item', pi.id, pi.plan_id, null, 'plan_item', po.number,
       coalesce(pi.title, po.title), coalesce(pi.description, po.caption), pi.created_by, pi.created_at
from plan_items pi cross join q
left join posts po on po.id = pi.post_id and po.deleted_at is null
where pi.workspace_id = p_workspace_id and pi.deleted_at is null
  and (pi.title ilike q.lk or pi.description ilike q.lk or po.title ilike q.lk or po.caption ilike q.lk)
union all
select * from (
  select distinct on (i.id)
         'plan_item_comment'::text, i.id, i.plan_id, null::text, 'plan_item'::text, po.number,
         coalesce(i.title, po.title), pc.body, pc.author_user_id, pc.created_at
  from plan_item_comments pc
  join plan_items i on i.id = pc.item_id and i.deleted_at is null
  left join posts po on po.id = i.post_id and po.deleted_at is null
  cross join q
  where pc.workspace_id = p_workspace_id and pc.deleted_at is null and pc.body ilike q.lk
  order by i.id, pc.created_at desc, pc.id desc
) pic
union all
select 'task', t.id, null, t.channel_id, 'task', t.number, t.title, t.note, t.created_by, t.created_at
from chat_tasks t, q
where t.workspace_id = p_workspace_id and t.deleted_at is null
  and (t.title ilike q.lk or t.note ilike q.lk)
union all
select 'chat_group', g.id, null, ch.channel_id, 'group', null, g.name, null, g.created_by, g.created_at
from groups g join chat_channels ch on ch.channel_type = 'group' and ch.entity_id = g.id, q
where g.workspace_id = p_workspace_id and g.deleted_at is null and g.name ilike q.lk
union all
select 'activity', e.id,
       case when e.entity_type = 'plan_item'
             and e.payload->>'plan_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then (e.payload->>'plan_id')::uuid
            when e.entity_type <> 'chat_channel'
             and e.entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then e.entity_id::uuid end,
       case when e.entity_type = 'chat_channel' then e.entity_id end,
       coalesce(e.entity_type, 'activity'),
       coalesce(ap.number, ab.number),
       coalesce(ap.title, ab.title, apl.title, ai.title, aip.title,
                e.payload->>'title', e.payload->>'post_title', e.payload->>'plan_title',
                e.payload->>'brief_title', e.payload->>'workspace_name', ''),
       e.event_type, e.actor_user_id, e.created_at
from activity_search_matches(p_workspace_id, p_query) e
left join posts ap on e.entity_type = 'post' and ap.deleted_at is null
  and ap.id = case when e.entity_type = 'post' and e.entity_id ~ '^[0-9a-f-]{36}$' then e.entity_id::uuid end
left join briefs ab on e.entity_type = 'brief' and ab.deleted_at is null
  and ab.id = case when e.entity_type = 'brief' and e.entity_id ~ '^[0-9a-f-]{36}$' then e.entity_id::uuid end
left join plans apl on e.entity_type = 'plan' and apl.deleted_at is null
  and apl.id = case when e.entity_type = 'plan' and e.entity_id ~ '^[0-9a-f-]{36}$' then e.entity_id::uuid end
left join plan_items ai on e.entity_type = 'plan_item' and ai.deleted_at is null
  and ai.id = case when e.entity_type = 'plan_item' and e.entity_id ~ '^[0-9a-f-]{36}$' then e.entity_id::uuid end
left join posts aip on aip.id = ai.post_id and aip.deleted_at is null;
$function$
;

CREATE OR REPLACE FUNCTION public.chat_message_search(p_workspace_id uuid, p_query text, p_trace_id uuid, p_channel_id text DEFAULT NULL::text, p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_kind text DEFAULT NULL::text)
 RETURNS SETOF chat_messages
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with terms as (
    select string_agg('''' || t || ''':*', ' & ') as q
    from regexp_split_to_table(
      lower(regexp_replace(coalesce(p_query, ''), '[&|!():*<>''"\\]', ' ', 'g')),
      '\s+') as t
    where length(t) > 0
  ),
  people as (
    select string_agg('''' || u.id::text || '''', ' | ') as q
    from public.workspace_members wm
    join public.users u on u.id = wm.user_id
    where wm.workspace_id = p_workspace_id
      and length(trim(coalesce(p_query, ''))) between 2 and 100
      and (u.display_name ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           or u.username ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
  )
  select m.*
  from public.chat_messages m, terms, people
  where m.workspace_id = p_workspace_id
    and m.deleted_at is null
    and (p_channel_id is null or m.channel_id = p_channel_id)
    and (
         (terms.q is null and p_kind is not null)
      or (terms.q is not null
          and length(trim(p_query)) between 2 and 100
          and to_tsvector('simple'::regconfig, coalesce(m.body, ''::text))
              @@ case when people.q is null
                      then to_tsquery('simple'::regconfig, terms.q)
                      else to_tsquery('simple'::regconfig, terms.q) || to_tsquery('simple'::regconfig, people.q)
                 end))
    and (
         p_kind is null
      or (p_kind = 'link' and m.body ~* 'https?://')
      or (p_kind in ('photo','voice','file') and exists (
            select 1
            from jsonb_each(case when jsonb_typeof(m.attachment_meta) = 'object' then m.attachment_meta else '{}'::jsonb end) e
            where case p_kind
                    when 'photo' then coalesce(e.value->>'mime','') like 'image/%'
                    when 'voice' then coalesce(e.value->>'mime','') like 'audio/%'
                    else not (coalesce(e.value->>'mime','') like 'image/%' or coalesce(e.value->>'mime','') like 'audio/%')
                  end)))
    and (p_before_created_at is null
         or m.created_at < p_before_created_at
         or (m.created_at = p_before_created_at and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
$function$
;

CREATE OR REPLACE FUNCTION public.posts_search(p_trace_id uuid, p_workspace_id uuid, p_query text DEFAULT NULL::text, p_stage text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, workspace_id uuid, title text, caption text, bucket_id uuid, owner_user_id uuid, platform text, format text, stage text, target_date timestamp with time zone, origin text, brief_id uuid, row_version bigint, created_by uuid, created_at timestamp with time zone, updated_at timestamp with time zone, deleted_at timestamp with time zone, stage_entered_at timestamp with time zone, legacy_author_name text, number integer, approved_by uuid, approved_at timestamp with time zone, approved_on_behalf_of uuid, thumbnail_asset_version_id uuid, first_media_asset_version_id uuid, first_media_kind text, first_media_width integer, first_media_height integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH q AS (
    SELECT nullif(trim(p_query), '') AS raw,
           (SELECT string_agg('''' || t || ''':*', ' & ')
              FROM regexp_split_to_table(lower(regexp_replace(coalesce(p_query, ''),
                   '[&|!():*<>''"\\]', ' ', 'g')), '\s+') t
             WHERE length(t) > 0) AS ts)
  SELECT p.id, p.workspace_id, p.title, p.caption, p.bucket_id, p.owner_user_id, p.platform, p.format, p.stage, p.target_date, p.origin,
         p.brief_id, p.row_version, p.created_by, p.created_at, p.updated_at, p.deleted_at, p.stage_entered_at, p.legacy_author_name,
         p.number, p.approved_by, p.approved_at, p.approved_on_behalf_of,
         th.v, fm.asset_version_id, fm.kind, fm.width, fm.height
    FROM (SELECT p0.* FROM public.posts p0 CROSS JOIN q
           WHERE p0.workspace_id = p_workspace_id AND p0.deleted_at IS NULL
             AND (p_stage IS NULL OR p0.stage = p_stage)
             AND (p_before IS NULL OR p0.created_at < p_before)
             AND (q.raw IS NULL
                  OR (length(q.raw) BETWEEN 2 AND 100 AND q.ts IS NOT NULL
                      AND to_tsvector('english'::regconfig, (coalesce(p0.title, '') || ' ') || coalesce(p0.caption, ''))
                          @@ to_tsquery('english'::regconfig, q.ts)))
           ORDER BY p0.created_at DESC, p0.id DESC
           LIMIT least(greatest(coalesce(p_limit, 50), 0), 500)) p
    LEFT JOIN LATERAL (SELECT aa.asset_version_id v FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                        WHERE aa.entity_type = 'post' AND aa.entity_id = p.id::text AND aa.deleted_at IS NULL AND av.mime_type LIKE 'image/%'
                        ORDER BY aa.position, aa.attached_at LIMIT 1) th ON true
    LEFT JOIN LATERAL (SELECT aa.asset_version_id, CASE WHEN av.mime_type LIKE 'image/%' THEN 'image' ELSE 'video' END kind, av.width, av.height
                         FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                        WHERE aa.entity_type = 'post' AND aa.entity_id = p.id::text AND aa.deleted_at IS NULL
                          AND (av.mime_type LIKE 'image/%' OR av.mime_type LIKE 'video/%')
                        ORDER BY aa.position, aa.attached_at LIMIT 1) fm ON true
   ORDER BY p.created_at DESC, p.id DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.posts_list(p_trace_id uuid, p_workspace_id uuid, p_stage text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, workspace_id uuid, title text, caption text, bucket_id uuid, owner_user_id uuid, platform text, format text, stage text, target_date timestamp with time zone, origin text, brief_id uuid, row_version bigint, created_by uuid, created_at timestamp with time zone, updated_at timestamp with time zone, deleted_at timestamp with time zone, stage_entered_at timestamp with time zone, legacy_author_name text, number integer, approved_by uuid, approved_at timestamp with time zone, approved_on_behalf_of uuid, thumbnail_asset_version_id uuid, first_media_asset_version_id uuid, first_media_kind text, first_media_width integer, first_media_height integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT * FROM public.posts_search(p_trace_id, p_workspace_id, NULL::text, p_stage, p_limit, p_before);
$function$
;

CREATE OR REPLACE FUNCTION public.plan_search(p_workspace_id uuid, p_query text, p_trace_id uuid, p_limit integer DEFAULT 100)
 RETURNS TABLE(plan_id uuid, item_id uuid, starts_on date, ends_on date, item_target_date date, post_target_at timestamp with time zone, matched text[])
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with q as (
  select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as lk
  where length(trim(coalesce(p_query, ''))) between 2 and 100
),
hits as (
  select pl.id as plan_id, null::uuid as item_id, 'plan'::text as matched
  from public.plans pl cross join q
  where pl.workspace_id = p_workspace_id and pl.deleted_at is null and pl.title ilike q.lk
  union all
  select i.plan_id, i.id,
         case when i.title ilike q.lk or i.description ilike q.lk then 'item' else 'post' end
  from public.plan_items i
  cross join q
  left join public.posts po on po.id = i.post_id and po.deleted_at is null
  where i.workspace_id = p_workspace_id and i.deleted_at is null
    and (i.title ilike q.lk or i.description ilike q.lk or po.title ilike q.lk or po.caption ilike q.lk)
  union all
  select i.plan_id, i.id, 'comment'
  from public.plan_item_comments pc
  join public.plan_items i on i.id = pc.item_id and i.deleted_at is null
  cross join q
  where pc.workspace_id = p_workspace_id and pc.deleted_at is null and pc.body ilike q.lk
),
grouped as (
  select h.plan_id, h.item_id, array_agg(distinct h.matched order by h.matched) as matched
  from hits h
  group by h.plan_id, h.item_id
)
select g.plan_id, g.item_id, pl.starts_on, pl.ends_on, i.target_date, po.target_date, g.matched
from grouped g
join public.plans pl on pl.id = g.plan_id and pl.deleted_at is null
left join public.plan_items i on i.id = g.item_id
left join public.posts po on po.id = i.post_id and po.deleted_at is null
order by pl.starts_on desc, pl.id desc, i.position nulls first, g.item_id
limit least(greatest(coalesce(p_limit, 100), 1), 200);
$function$
;

REVOKE ALL ON FUNCTION public.activity_search_matches(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_search_matches(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.activity_search(uuid, text, uuid, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_search(uuid, text, uuid, timestamptz, uuid, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.posts_search(uuid, uuid, text, text, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.posts_search(uuid, uuid, text, text, integer, timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.plan_search(uuid, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plan_search(uuid, text, uuid, integer) TO authenticated;
