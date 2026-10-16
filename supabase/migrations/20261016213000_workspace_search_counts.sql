create or replace function public.workspace_search_matches(p_workspace_id uuid, p_query text)
returns table(kind text, id uuid, parent_id uuid, channel_id text, entity_type text,
  number integer, title text, body text, actor uuid, created_at timestamptz)
language sql stable security invoker set search_path = public, pg_temp
as $$
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
select 'plan_item', pi.id, pi.plan_id, null, 'plan_item', null, pi.title, pi.description, pi.created_by, pi.created_at
from plan_items pi, q where pi.workspace_id = p_workspace_id and pi.deleted_at is null
  and (pi.title ilike q.lk or pi.description ilike q.lk)
union all
select 'task', t.id, null, t.channel_id, 'task', t.number, t.title, t.note, t.created_by, t.created_at
from chat_tasks t, q where t.workspace_id = p_workspace_id and (t.title ilike q.lk or t.note ilike q.lk)
union all
select 'chat_group', g.id, null, ch.channel_id, 'group', null, g.name, null, g.created_by, g.created_at
from groups g join chat_channels ch on ch.channel_type = 'group' and ch.entity_id = g.id, q
where g.workspace_id = p_workspace_id and g.deleted_at is null and g.name ilike q.lk;
$$;

create or replace function public.workspace_search_grouped(
  p_workspace_id uuid, p_query text, p_trace_id uuid, p_per_kind integer default 5)
returns table(kind text, id uuid, parent_id uuid, channel_id text, entity_type text,
  number integer, title text, snippet text, actor_user_id uuid,
  actor_is_member boolean, created_at timestamptz)
language sql stable security invoker set search_path = public, pg_temp
as $$
with ranked as (
  select m.*, row_number() over (partition by m.kind order by m.created_at desc) rn
  from public.workspace_search_matches(p_workspace_id, p_query) m
)
select x.kind, x.id, x.parent_id, x.channel_id, x.entity_type, x.number, x.title,
       regexp_replace(left(coalesce(x.body, ''), 160), '@\[[^\]]*$', ''),
       x.actor, (wm.user_id is not null), x.created_at
from ranked x
left join workspace_members wm
  on wm.workspace_id = p_workspace_id and wm.user_id = x.actor and wm.active and wm.removed_at is null
where x.rn <= least(greatest(coalesce(p_per_kind, 5), 1), 20)
order by x.kind, x.created_at desc;
$$;

create or replace function public.workspace_search_counts(
  p_workspace_id uuid, p_query text, p_trace_id uuid)
returns table(kind text, total integer)
language sql stable security invoker set search_path = public, pg_temp
as $$
  select m.kind, count(*)::integer
  from public.workspace_search_matches(p_workspace_id, p_query) m
  group by m.kind;
$$;

revoke all on function public.workspace_search_matches(uuid, text) from public, anon;
revoke all on function public.workspace_search_counts(uuid, text, uuid) from public, anon;
grant execute on function public.workspace_search_matches(uuid, text) to authenticated;
grant execute on function public.workspace_search_counts(uuid, text, uuid) to authenticated;
