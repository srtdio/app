create or replace function public.chat_message_search(
  p_workspace_id uuid,
  p_query text,
  p_trace_id uuid,
  p_channel_id text default null,
  p_before_created_at timestamptz default null,
  p_before_id text default null,
  p_limit integer default 30
) returns setof public.chat_messages
language sql stable security invoker
set search_path = public, pg_temp
as $$
  with terms as (
    select string_agg('''' || t || ''':*', ' & ') as q
    from regexp_split_to_table(
      lower(regexp_replace(coalesce(p_query, ''), '[&|!():*<>''"\\]', ' ', 'g')),
      '\s+') as t
    where length(t) > 0
  )
  select m.*
  from public.chat_messages m, terms
  where terms.q is not null
    and length(trim(p_query)) between 2 and 100
    and m.workspace_id = p_workspace_id
    and m.deleted_at is null
    and (p_channel_id is null or m.channel_id = p_channel_id)
    and to_tsvector('simple'::regconfig, coalesce(m.body, ''::text))
        @@ to_tsquery('simple'::regconfig, terms.q)
    and (p_before_created_at is null
         or m.created_at < p_before_created_at
         or (m.created_at = p_before_created_at
             and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
$$;

revoke all on function public.chat_message_search(uuid, text, uuid, text, timestamptz, text, integer) from public, anon;
grant execute on function public.chat_message_search(uuid, text, uuid, text, timestamptz, text, integer) to authenticated;
