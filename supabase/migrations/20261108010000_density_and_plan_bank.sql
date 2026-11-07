-- Density (Compact / Cozy / Calm) per account + New plan "Add from bank".
-- Already applied on movnexawfhsyuluspxoc (8 Nov 2026). Recorded verbatim from
-- pg_get_functiondef. The old 7-arg plan_create_with_items overload stays (no DROP);
-- the app calls only the 8-arg one (p_bank [] when none).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS density text NOT NULL DEFAULT 'cozy';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_density_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_density_check CHECK ((density = ANY (ARRAY['compact'::text, 'cozy'::text, 'calm'::text])));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.user_density_set(p_density text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ declare v_uid uuid := auth.uid(); v_d text := lower(trim(coalesce(p_density, ''))); begin if v_uid is null or v_d not in ('compact','cozy','calm') then raise exception 'invalid_payload'; end if; update public.users set density = v_d where id = v_uid; if not found then raise exception 'invalid_payload'; end if; perform public.audit_log_write(p_action => 'user_density_set', p_outcome => 'success', p_trace_id => p_trace_id, p_entity_type => 'user', p_entity_id => v_uid::text, p_payload => jsonb_build_object('density', v_d)); return v_uid; end; $function$;

REVOKE EXECUTE ON FUNCTION public.user_density_set(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_density_set(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.plan_create_with_items(p_workspace_id uuid, p_title text, p_starts_on date, p_ends_on date, p_concepts jsonb, p_posts jsonb, p_bank jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_plan uuid; v_c jsonb; v_date date; v_ids uuid[]; v_nc int; v_np int; v_nb int; v_tz text; v_first date;
begin
  if p_concepts is null or jsonb_typeof(p_concepts) <> 'array' or p_posts is null or jsonb_typeof(p_posts) <> 'array' or p_bank is null or jsonb_typeof(p_bank) <> 'array' then raise exception 'invalid_payload'; end if;
  v_nc := jsonb_array_length(p_concepts); v_np := jsonb_array_length(p_posts); v_nb := jsonb_array_length(p_bank);
  if v_nc + v_np + v_nb = 0 or v_nc > 50 or v_np > 50 or v_nb > 50 then raise exception 'invalid_payload'; end if;
  begin
    if v_np <> (select count(distinct (e->>'post_id')::uuid) from jsonb_array_elements(p_posts) e) then raise exception 'invalid_payload'; end if;
    if v_nb <> (select count(distinct (e->>'item_id')::uuid) from jsonb_array_elements(p_bank) e) then raise exception 'invalid_payload'; end if;
    v_plan := public.plan_create(p_workspace_id, p_title, p_starts_on, p_ends_on, 'team', p_trace_id);
    for v_c in select e from jsonb_array_elements(p_concepts) with ordinality t(e, o) order by o loop
      perform public.plan_concept_add(v_plan, v_c->>'title', v_c->>'description', array(select x::uuid from jsonb_array_elements_text(coalesce(v_c->'attachment_version_ids', '[]'::jsonb)) x), p_trace_id, nullif(v_c->>'target_date', '')::date);
    end loop;
    select array_agg((e->>'post_id')::uuid order by o) into v_ids from jsonb_array_elements(p_posts) with ordinality t(e, o) where nullif(e->>'target_date', '') is null;
    if v_ids is not null then
      update public.posts set target_date = null, row_version = row_version + 1 where id = any (v_ids) and workspace_id = p_workspace_id and deleted_at is null and target_date is not null;
      perform public.plan_posts_add(v_plan, v_ids, p_trace_id, null);
    end if;
    for v_date, v_ids in select (e->>'target_date')::date, array_agg((e->>'post_id')::uuid order by o) from jsonb_array_elements(p_posts) with ordinality t(e, o) where nullif(e->>'target_date', '') is not null group by 1 order by 1 loop
      perform public.plan_posts_add(v_plan, v_ids, p_trace_id, v_date);
    end loop;
    if v_nb > 0 then
      select timezone into v_tz from public.workspaces where id = p_workspace_id;
      v_first := greatest(p_starts_on, (now() at time zone coalesce(v_tz, 'UTC'))::date);
      for v_c in select e from jsonb_array_elements(p_bank) with ordinality t(e, o) order by o loop
        perform public.plan_item_from_bank((v_c->>'item_id')::uuid, v_plan, coalesce(nullif(v_c->>'target_date', '')::date, v_first), p_trace_id);
      end loop;
    end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'invalid_payload';
  end;
  return v_plan;
end $function$;

REVOKE EXECUTE ON FUNCTION public.plan_create_with_items(uuid, text, date, date, jsonb, jsonb, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plan_create_with_items(uuid, text, date, date, jsonb, jsonb, jsonb, uuid) TO authenticated;
