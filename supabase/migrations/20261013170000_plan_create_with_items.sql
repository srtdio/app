-- Applied out of band 13 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- Plan create in one step: plan_create_with_items creates a Draft (team) plan,
-- adds concepts in order and posts grouped by day in one transaction; any
-- failure saves nothing. Function body is verbatim pg_get_functiondef from live.
--
-- Rollback: drop function public.plan_create_with_items(uuid, text, date, date, jsonb, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.plan_create_with_items(p_workspace_id uuid, p_title text, p_starts_on date, p_ends_on date, p_concepts jsonb, p_posts jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_plan uuid; v_c jsonb; v_date date; v_ids uuid[]; v_nc int; v_np int;
begin
  if p_concepts is null or jsonb_typeof(p_concepts) <> 'array'
     or p_posts is null or jsonb_typeof(p_posts) <> 'array' then raise exception 'invalid_payload'; end if;
  v_nc := jsonb_array_length(p_concepts); v_np := jsonb_array_length(p_posts);
  if v_nc + v_np = 0 or v_nc > 50 or v_np > 50 then raise exception 'invalid_payload'; end if;
  begin
    if v_np <> (select count(distinct (e->>'post_id')::uuid) from jsonb_array_elements(p_posts) e)
    then raise exception 'invalid_payload'; end if;

    v_plan := public.plan_create(p_workspace_id, p_title, p_starts_on, p_ends_on, 'team', p_trace_id);

    for v_c in select e from jsonb_array_elements(p_concepts) with ordinality t(e, o) order by o loop
      perform public.plan_concept_add(v_plan, v_c->>'title', v_c->>'description',
        array(select x::uuid from jsonb_array_elements_text(coalesce(v_c->'attachment_version_ids', '[]'::jsonb)) x),
        p_trace_id, nullif(v_c->>'target_date', '')::date);
    end loop;

    select array_agg((e->>'post_id')::uuid order by o) into v_ids
      from jsonb_array_elements(p_posts) with ordinality t(e, o)
     where nullif(e->>'target_date', '') is null;
    if v_ids is not null then
      update public.posts set target_date = null, row_version = row_version + 1
       where id = any (v_ids) and workspace_id = p_workspace_id
         and deleted_at is null and target_date is not null;
      perform public.plan_posts_add(v_plan, v_ids, p_trace_id, null);
    end if;

    for v_date, v_ids in
      select (e->>'target_date')::date, array_agg((e->>'post_id')::uuid order by o)
        from jsonb_array_elements(p_posts) with ordinality t(e, o)
       where nullif(e->>'target_date', '') is not null
       group by 1 order by 1
    loop
      perform public.plan_posts_add(v_plan, v_ids, p_trace_id, v_date);
    end loop;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
    then raise exception 'invalid_payload';
  end;
  return v_plan;
end $function$
;

revoke all on function public.plan_create_with_items(uuid, text, date, date, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.plan_create_with_items(uuid, text, date, date, jsonb, jsonb, uuid) to authenticated;
