-- Record of a schema change ALREADY APPLIED LIVE on movnexawfhsyuluspxoc (18 Oct 2026, via MCP).
-- inbox_self_entry no longer writes the actor's own row for actions on onboarding sample
-- posts or briefs (induction_sample_rows): those rows would outlive induction_sample_clear
-- and point at deleted sample content. No delete; grants unchanged (owner-only).

create or replace function public.inbox_self_entry(p_workspace_id uuid, p_event_type text, p_entity_type text,
  p_entity_id text, p_scope text, p_scope_key text, p_payload jsonb)
returns void language plpgsql security definer set search_path to '' as $f$
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.induction_sample_rows s
              where s.workspace_id = p_workspace_id and s.row_id = p_entity_id
                and s.kind in ('post','brief')) then return; end if;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key,
                                    tier, payload, actor_user_id, read_at)
  values (auth.uid(), p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_scope, p_scope_key,
          'active', p_payload, auth.uid(), now());
end $f$;
revoke execute on function public.inbox_self_entry(uuid,text,text,text,text,text,jsonb) from public, anon, authenticated, service_role;
