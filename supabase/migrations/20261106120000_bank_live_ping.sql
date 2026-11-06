-- Schema already applied via MCP on 6 Nov 2026. Do NOT execute. Do NOT run supabase db push.
-- Applied live 6 Nov 2026 via MCP on v2 (movnexawfhsyuluspxoc); this file is the record.
-- Live Bank: every change to a bank idea (a plan_items row with no plan, before
-- or after the change), its buckets or its comments, and every workspace
-- bucket change, sends one broadcast 'changed' on the private topic
-- 'bank:<workspace_id>' with ids only ({workspace_id, item_id, what}); no
-- titles, bodies or flags ever travel. An open Bank re-reads its page through
-- the existing RLS. Receiving is gated by bank_live_can_receive: an active
-- agency-side member (owner, admin, agency) of the workspace; a client never.
-- _plan_live_ping also pings the plan an item left (v_old_plan), so a Plan
-- screen showing a concept that moved to the bank drops it live.
-- Writes stay last-save-wins, as every bank proc already is.

BEGIN;
create or replace function public.bank_live_can_receive(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = (select auth.uid()) and wm.active = true
      and wm.role = any (array['owner','admin','agency'])
  );
$$;
revoke all on function public.bank_live_can_receive(uuid) from public;
grant execute on function public.bank_live_can_receive(uuid) to authenticated;

create policy bank_live_receive on realtime.messages
for select to authenticated
using (
  extension = 'broadcast'
  and topic = realtime.topic()
  and case
        when realtime.topic() ~ '^bank:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then public.bank_live_can_receive(substr(realtime.topic(), 6)::uuid)
        else false
      end
);

create or replace function public._plan_live_ping()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_plan uuid; v_old_plan uuid; v_item uuid;
begin
  if tg_table_name = 'plans' then
    v_plan := (v_row->>'id')::uuid;
  elsif tg_table_name = 'plan_items' then
    v_plan := (v_row->>'plan_id')::uuid;
    v_item := (v_row->>'id')::uuid;
    if tg_op = 'UPDATE' then v_old_plan := old.plan_id; end if;
  else
    v_item := (v_row->>'item_id')::uuid;
    select i.plan_id into v_plan from public.plan_items i where i.id = v_item;
  end if;
  if v_plan is not null then
    perform realtime.send(jsonb_build_object('plan_id', v_plan, 'item_id', v_item, 'what', tg_table_name), 'changed', 'plan:' || v_plan::text, true);
  end if;
  if v_old_plan is not null and v_old_plan is distinct from v_plan then
    perform realtime.send(jsonb_build_object('plan_id', v_old_plan, 'item_id', v_item, 'what', tg_table_name), 'changed', 'plan:' || v_old_plan::text, true);
  end if;
  return null;
end;
$$;

create or replace function public._bank_live_ping()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_ws uuid; v_item uuid; v_hit boolean := false;
begin
  if tg_table_name = 'plan_items' then
    v_ws := coalesce((v_new->>'workspace_id'), (v_old->>'workspace_id'))::uuid;
    v_item := coalesce((v_new->>'id'), (v_old->>'id'))::uuid;
    v_hit := (v_new is not null and v_new->>'plan_id' is null) or (v_old is not null and v_old->>'plan_id' is null);
  elsif tg_table_name = 'workspace_buckets' then
    v_ws := coalesce((v_new->>'workspace_id'), (v_old->>'workspace_id'))::uuid;
    v_hit := true;
  else
    v_item := coalesce((v_new->>'item_id'), (v_old->>'item_id'))::uuid;
    select i.workspace_id, i.plan_id is null into v_ws, v_hit from public.plan_items i where i.id = v_item;
  end if;
  if v_hit and v_ws is not null then
    perform realtime.send(jsonb_build_object('workspace_id', v_ws, 'item_id', v_item, 'what', tg_table_name), 'changed', 'bank:' || v_ws::text, true);
  end if;
  return null;
end;
$$;
revoke all on function public._bank_live_ping() from public;

create trigger plan_items_bank_live_ping after insert or update or delete on public.plan_items for each row execute function public._bank_live_ping();
create trigger plan_item_buckets_bank_live_ping after insert or update or delete on public.plan_item_buckets for each row execute function public._bank_live_ping();
create trigger plan_item_comments_bank_live_ping after insert or update or delete on public.plan_item_comments for each row execute function public._bank_live_ping();
create trigger workspace_buckets_bank_live_ping after insert or update or delete on public.workspace_buckets for each row execute function public._bank_live_ping();
COMMIT;
