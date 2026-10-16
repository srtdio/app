-- Record of a function ALREADY APPLIED LIVE on movnexawfhsyuluspxoc (16 Oct 2026). Do not execute.
-- Workspace-wide search over posts (title+caption), briefs (title+objective) and comments on posts/briefs.
-- SECURITY INVOKER: RLS decides visibility (clients never see drafts). Chat uses chat_message_search.
create or replace function public.workspace_search(
  p_workspace_id uuid, p_query text, p_trace_id uuid, p_limit integer default 20)
returns table(kind text, id uuid, entity_type text, entity_id uuid,
              entity_number integer, title text, snippet text, created_at timestamptz)
language sql stable security invoker set search_path to 'public','pg_temp' as $$
with terms as (
  select string_agg('''' || t || ''':*', ' & ') as q
  from regexp_split_to_table(lower(regexp_replace(coalesce(p_query,''),
       '[&|!():*<>''"\\]', ' ', 'g')), '\s+') as t
  where length(t) > 0 and length(trim(p_query)) between 2 and 100
)
select * from (
  select 'post', p.id, 'post', p.id, p.number, p.title, left(coalesce(p.caption,''),160), p.created_at
  from posts p, terms
  where p.workspace_id = p_workspace_id and p.deleted_at is null and terms.q is not null
    and to_tsvector('english',(coalesce(p.title,'')||' ')||coalesce(p.caption,'')) @@ to_tsquery('english',terms.q)
  union all
  select 'brief', b.id, 'brief', b.id, b.number, b.title, left(b.objective,160), b.created_at
  from briefs b, terms
  where b.workspace_id = p_workspace_id and b.deleted_at is null and terms.q is not null
    and to_tsvector('english',(b.title||' ')||b.objective) @@ to_tsquery('english',terms.q)
  union all
  select 'comment', c.id, c.entity_type, c.entity_id, coalesce(p.number,b.number),
         coalesce(p.title,b.title), left(c.body,160), c.created_at
  from comments c cross join terms
  left join posts p on c.entity_type='post' and p.id=c.entity_id and p.deleted_at is null
  left join briefs b on c.entity_type='brief' and b.id=c.entity_id and b.deleted_at is null
  where c.workspace_id = p_workspace_id and c.deleted_at is null and terms.q is not null
    and c.entity_type in ('post','brief') and (p.id is not null or b.id is not null)
    and to_tsvector('english',c.body) @@ to_tsquery('english',terms.q)
) r
order by 8 desc
limit least(greatest(coalesce(p_limit,20),1),50);
$$;
revoke all on function public.workspace_search(uuid,text,uuid,integer) from public, anon;
grant execute on function public.workspace_search(uuid,text,uuid,integer) to authenticated;
