-- Search inside a chat (13 Nov 2026): chat_message_search also matches a
-- message's file names (attachment_meta -> name, case-insensitive substring)
-- when the search is scoped to one chat (p_channel_id set). The app-wide search
-- (no p_channel_id) is unchanged. Same signature, grants kept (CREATE OR REPLACE).
-- Applied via Supabase MCP 13 Nov 2026.

create or replace function public.chat_message_search(p_workspace_id uuid, p_query text, p_trace_id uuid, p_channel_id text default null::text, p_before_created_at timestamptz default null::timestamptz, p_before_id text default null::text, p_limit integer default 30, p_kind text default null::text)
returns setof chat_messages language sql stable set search_path to 'public', 'pg_temp' as $function$
  with terms as (
    select string_agg('''' || t || ''':*', ' & ') as q
    from regexp_split_to_table(lower(regexp_replace(coalesce(p_query, ''), '[&|!():*<>''"\\]', ' ', 'g')), '\s+') as t
    where length(t) > 0
  ),
  people as (
    select string_agg('''' || u.id::text || '''', ' | ') as q
    from public.workspace_members wm join public.users u on u.id = wm.user_id
    where wm.workspace_id = p_workspace_id
      and length(trim(coalesce(p_query, ''))) between 2 and 100
      and (u.display_name ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           or u.username ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
  )
  select m.* from public.chat_messages m, terms, people
  where m.workspace_id = p_workspace_id
    and m.deleted_at is null
    and (p_channel_id is null or m.channel_id = p_channel_id)
    and (
         (terms.q is null and p_kind is not null)
      or (terms.q is not null and length(trim(p_query)) between 2 and 100
          and (to_tsvector('simple'::regconfig, coalesce(m.body, ''::text))
                 @@ case when people.q is null then to_tsquery('simple'::regconfig, terms.q)
                         else to_tsquery('simple'::regconfig, terms.q) || to_tsquery('simple'::regconfig, people.q) end
               or (p_channel_id is not null and exists (
                     select 1 from jsonb_each(case when jsonb_typeof(m.attachment_meta) = 'object' then m.attachment_meta else '{}'::jsonb end) f
                     where coalesce(f.value->>'name', '') ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')))))
    and (
         p_kind is null
      or (p_kind = 'link' and m.body ~* 'https?://')
      or (p_kind in ('photo','video','voice','file') and exists (
            select 1 from jsonb_each(case when jsonb_typeof(m.attachment_meta) = 'object' then m.attachment_meta else '{}'::jsonb end) e
            where case p_kind
                    when 'photo' then coalesce(e.value->>'mime','') like 'image/%'
                    when 'video' then coalesce(e.value->>'mime','') like 'video/%'
                    when 'voice' then coalesce(e.value->>'mime','') like 'audio/%'
                    else not (coalesce(e.value->>'mime','') like 'image/%' or coalesce(e.value->>'mime','') like 'video/%' or coalesce(e.value->>'mime','') like 'audio/%')
                  end)))
    and (p_before_created_at is null or m.created_at < p_before_created_at
         or (m.created_at = p_before_created_at and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
$function$;
