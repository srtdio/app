-- Schema already applied via MCP on 5 Nov 2026. Do NOT execute. Do NOT run supabase db push.
-- Applied live 5 Nov 2026 via MCP on v2 (movnexawfhsyuluspxoc); this file is the record.
-- Live Plan: every change to a plan, its items, their reviews or their comments
-- sends one broadcast 'changed' on the private topic 'plan:<plan_id>' with ids
-- only ({plan_id, item_id, what}); no titles, bodies or statuses ever travel.
-- An open Plan or item screen re-reads through the existing RLS, so hidden rows
-- (old creators-only comments, draft plans) never leak through the ping.
-- Receiving is gated by plan_live_can_receive: an active member who can read
-- the plan (agency side always; a client only once the plan is shared).
-- Writes stay last-save-wins, as every plan proc already is.

create or replace function public.plan_live_can_receive(p_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.plans p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = p_plan_id
      and p.deleted_at is null
      and wm.user_id = (select auth.uid())
      and wm.active = true
      and (p.audience = 'client' or wm.role = any (array['owner','admin','agency']))
  );
$$;

revoke all on function public.plan_live_can_receive(uuid) from public;
grant execute on function public.plan_live_can_receive(uuid) to authenticated;

create policy plan_live_receive on realtime.messages
for select to authenticated
using (
  extension = 'broadcast'
  and topic = realtime.topic()
  and case
        when realtime.topic() ~ '^plan:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then public.plan_live_can_receive(substr(realtime.topic(), 6)::uuid)
        else false
      end
);

create or replace function public._plan_live_ping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_plan uuid;
  v_item uuid;
begin
  if tg_table_name = 'plans' then
    v_plan := (v_row->>'id')::uuid;
  elsif tg_table_name = 'plan_items' then
    v_plan := (v_row->>'plan_id')::uuid;
    v_item := (v_row->>'id')::uuid;
  else
    v_item := (v_row->>'item_id')::uuid;
    select i.plan_id into v_plan from public.plan_items i where i.id = v_item;
  end if;
  if v_plan is null then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object('plan_id', v_plan, 'item_id', v_item, 'what', tg_table_name),
    'changed',
    'plan:' || v_plan::text,
    true
  );
  return null;
end;
$$;

revoke all on function public._plan_live_ping() from public;

create trigger plans_live_ping
after update on public.plans
for each row execute function public._plan_live_ping();

create trigger plan_items_live_ping
after insert or update or delete on public.plan_items
for each row execute function public._plan_live_ping();

create trigger plan_item_reviews_live_ping
after insert or update or delete on public.plan_item_reviews
for each row execute function public._plan_live_ping();

create trigger plan_item_comments_live_ping
after insert or update or delete on public.plan_item_comments
for each row execute function public._plan_live_ping();
