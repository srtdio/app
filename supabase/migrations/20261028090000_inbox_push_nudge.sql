-- Activity push: a content-free broadcast nudge {w: workspace_id} on the
-- private topic inbox:<user_id> for every new inbox_entries row, so the client
-- ticks at once and the poll is only a safety net. Applied to
-- movnexawfhsyuluspxoc on 28 Oct 2026 via the Supabase MCP; recorded here.
create or replace function public._inbox_push_nudge()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct n.user_id, n.workspace_id from new_rows n where n.deleted_at is null loop
    begin
      perform realtime.send(jsonb_build_object('w', r.workspace_id), 'inbox', 'inbox:' || r.user_id::text, true);
    exception when others then
      raise warning 'inbox push nudge failed: %', sqlerrm;
    end;
  end loop;
  return null;
end;
$$;
revoke all on function public._inbox_push_nudge() from public, anon, authenticated;
create trigger inbox_entries_push_ins after insert on public.inbox_entries referencing new table as new_rows for each statement execute function public._inbox_push_nudge();
create policy inbox_push_receive_own on realtime.messages for select to authenticated using (realtime.messages.extension = 'broadcast' and realtime.topic() = 'inbox:' || (select auth.uid())::text);
-- rollback: drop trigger inbox_entries_push_ins on public.inbox_entries; drop function public._inbox_push_nudge(); drop policy inbox_push_receive_own on realtime.messages;
