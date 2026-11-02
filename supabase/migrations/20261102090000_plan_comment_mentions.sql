CREATE OR REPLACE FUNCTION public._plan_item_notify_except(p_item_id uuid, p_event_type text, p_team_only boolean, p_payload jsonb, p_exclude uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_plan uuid;
begin
  select i.workspace_id, p.audience, p.id into v_ws, v_aud, v_plan
    from public.plan_items i join public.plans p on p.id = i.plan_id where i.id = p_item_id;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, p_event_type, 'plan_item', p_item_id::text, 'posts', v_plan::text, 'active',
         p_payload || jsonb_build_object('plan_id', v_plan), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id <> auth.uid()
     and wm.user_id <> all (coalesce(p_exclude, '{}'::uuid[]))
     and (wm.role = any (array['owner','admin','agency'])
          or (not p_team_only and v_aud = 'client' and wm.role = 'client'));
end $function$;

REVOKE ALL ON FUNCTION public._plan_item_notify_except(uuid, text, boolean, jsonb, uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._plan_item_notify(p_item_id uuid, p_event_type text, p_team_only boolean, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public._plan_item_notify_except(p_item_id, p_event_type, p_team_only, p_payload, '{}'::uuid[]);
end $function$;

CREATE OR REPLACE FUNCTION public.plan_item_comment_create(p_item_id uuid, p_body text, p_visibility text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_plan uuid; v_agency boolean; v_id uuid; v_mentioned uuid[]; v_invalid uuid[];
begin
  select i.workspace_id, p.audience, p.id into v_ws, v_aud, v_plan
    from public.plan_items i join public.plans p on p.id = i.plan_id
   where i.id = p_item_id and i.deleted_at is null and p.deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  if p_visibility not in ('everyone','team') then raise exception 'invalid_payload'; end if;
  v_agency := public.is_agency_side_member(v_ws);
  if not v_agency then
    if v_aud <> 'client' then raise exception 'forbidden_role'; end if;
    if p_visibility <> 'everyone' then raise exception 'forbidden_role'; end if;
  end if;
  select coalesce(array_agg(distinct s.x), '{}'::uuid[]) into v_mentioned from (
    select lower(t[1])::uuid x
      from regexp_matches(coalesce(p_body, ''), '@\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]', 'g') t
  ) s where s.x <> auth.uid();
  select array_agg(m) into v_invalid from unnest(v_mentioned) m
   where not exists (select 1 from public.workspace_members wm
                      where wm.workspace_id = v_ws and wm.user_id = m and wm.active = true
                        and (wm.role = any (array['owner','admin','agency'])
                             or (p_visibility = 'everyone' and v_aud = 'client' and wm.role = 'client')));
  if v_invalid is not null then
    raise exception 'invalid_mention' using detail = array_to_string(v_invalid, ',');
  end if;
  begin
    insert into public.plan_item_comments (workspace_id, item_id, author_user_id, body, visibility)
    values (v_ws, p_item_id, auth.uid(), btrim(p_body), p_visibility) returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public._plan_item_notify_except(p_item_id, 'plan_comment', p_visibility = 'team',
    jsonb_build_object('comment_id', v_id, 'visibility', p_visibility), v_mentioned);
  if array_length(v_mentioned, 1) is not null then
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select wm.user_id, v_ws, 'mention', 'plan_item', p_item_id::text, 'posts', v_plan::text, 'urgent',
           jsonb_build_object('comment_id', v_id, 'visibility', p_visibility, 'plan_id', v_plan), auth.uid()
      from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.active = true and wm.user_id = any (v_mentioned);
  end if;
  perform public.audit_log_write(p_action=>'plan_item_comment_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('comment_id', v_id, 'visibility', p_visibility, 'mentions', coalesce(array_length(v_mentioned, 1), 0)));
  return v_id;
end $function$;
