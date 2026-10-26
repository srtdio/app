-- Plan edits merge into one card per editor per plan per hour.
-- Mirrors the live body of public._plan_notify(uuid, text, jsonb), already
-- applied via Supabase MCP on 26 Oct 2026 (read back with pg_get_functiondef).
-- plan_updated and plan_date_changed no longer insert one row per edit: per
-- recipient they merge {plan_title, last_change_at} into the live 'edited'
-- plan_updated row the same actor started within the last hour, else insert
-- one new row {plan_id, plan_title, kind 'edited', last_change_at}. read_at is
-- never reset, so a merged edit never re-pings. An advisory lock per plan
-- serialises it. Every other event type inserts exactly as before; draft plans
-- (audience 'team') stay silent. Signature unchanged.
-- The one-off squash of old rows ran separately and is not repeated here.

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
  if v_aud = 'team' and p_event_type <> 'plan_deleted' then return; end if;
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
end $function$
;
