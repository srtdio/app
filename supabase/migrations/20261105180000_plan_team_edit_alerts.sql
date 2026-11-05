-- Plan edit alerts on team (Draft) plans: Shubham, 5 Nov 2026.
-- A plan still within the team now gets the same merged edit card a client plan
-- gets: plan_updated and plan_date_changed fold into one 'edited' row per editor
-- per plan per hour (20261026160000_plan_notify_merge_edits), sent to the other
-- agency-side members only. Clients never get a row for a team plan. Every other
-- event on a team plan stays silent except plan_deleted, as before.
-- Only the gate line changes; signature and grants (none) are unchanged, so no
-- types regen. Applied live via Supabase MCP on movnexawfhsyuluspxoc.

CREATE OR REPLACE FUNCTION public._plan_notify(p_plan_id uuid, p_event_type text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_title text; v_actor uuid := auth.uid();
begin
  select workspace_id, audience, title into v_ws, v_aud, v_title from public.plans where id = p_plan_id;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if v_aud = 'team' and p_event_type not in ('plan_deleted', 'plan_updated', 'plan_date_changed') then return; end if;
  if p_event_type in ('plan_updated', 'plan_date_changed') then
    perform pg_advisory_xact_lock(hashtextextended('plan_notify:' || p_plan_id::text, 0));
    update public.inbox_entries e
       set payload = e.payload || jsonb_build_object('plan_title', v_title, 'last_change_at', now())
      from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.active = true and wm.user_id is distinct from v_actor
       and (wm.role = any (array['owner','admin','agency']) or (v_aud = 'client' and wm.role = 'client'))
       and e.user_id = wm.user_id and e.workspace_id = v_ws
       and e.entity_type = 'plan' and e.entity_id = p_plan_id::text
       and e.event_type = 'plan_updated' and e.payload->>'kind' = 'edited'
       and e.actor_user_id is not distinct from v_actor and e.deleted_at is null
       and e.created_at > now() - interval '1 hour';
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select wm.user_id, v_ws, 'plan_updated', 'plan', p_plan_id::text, 'posts', p_plan_id::text, 'active',
           jsonb_build_object('plan_id', p_plan_id, 'plan_title', v_title, 'kind', 'edited', 'last_change_at', now()), v_actor
      from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.active = true and wm.user_id is distinct from v_actor
       and (wm.role = any (array['owner','admin','agency']) or (v_aud = 'client' and wm.role = 'client'))
       and not exists (
         select 1 from public.inbox_entries e
          where e.user_id = wm.user_id and e.workspace_id = v_ws
            and e.entity_type = 'plan' and e.entity_id = p_plan_id::text
            and e.event_type = 'plan_updated' and e.payload->>'kind' = 'edited'
            and e.actor_user_id is not distinct from v_actor and e.deleted_at is null
            and e.created_at > now() - interval '1 hour');
    return;
  end if;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, p_event_type, 'plan', p_plan_id::text, 'posts', p_plan_id::text, 'active',
         coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('plan_id', p_plan_id, 'plan_title', v_title), v_actor
    from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id is distinct from v_actor
     and (wm.role = any (array['owner','admin','agency']) or (v_aud = 'client' and wm.role = 'client'));
end $function$;
