alter table public.plan_item_comments
  add column parent_comment_id uuid null
    references public.plan_item_comments(id) on delete cascade,
  add column attachment_asset_ids uuid[] null;

create index plan_item_comments_parent_idx
  on public.plan_item_comments (parent_comment_id, created_at)
  where parent_comment_id is not null and deleted_at is null;

create table public.plan_item_comment_thread_reads (
  root_comment_id uuid not null references public.plan_item_comments(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  last_read_at    timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (root_comment_id, user_id)
);
create index plan_item_comment_thread_reads_user
  on public.plan_item_comment_thread_reads (user_id);
create index plan_item_comment_thread_reads_workspace
  on public.plan_item_comment_thread_reads (workspace_id);
alter table public.plan_item_comment_thread_reads enable row level security;
revoke all on public.plan_item_comment_thread_reads from anon, authenticated;
grant select on public.plan_item_comment_thread_reads to authenticated;
create policy plan_item_comment_thread_reads_own
  on public.plan_item_comment_thread_reads
  for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.plan_item_comment_send(
  p_item_id uuid, p_parent_comment_id uuid, p_body text, p_visibility text,
  p_attachment_version_ids uuid[], p_trace_id uuid)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_ws uuid; v_aud text; v_plan uuid; v_show boolean; v_agency boolean; v_id uuid;
  v_mentioned uuid[]; v_invalid uuid[]; v_client_sees boolean; v_vis text; v_n int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select i.workspace_id, p.audience, p.id, i.show_to_client into v_ws, v_aud, v_plan, v_show
    from public.plan_items i left join public.plans p on p.id = i.plan_id and p.deleted_at is null
   where i.id = p_item_id and i.deleted_at is null and (i.plan_id is null or p.id is not null);
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  v_agency := public.is_agency_side_member(v_ws);
  v_client_sees := (v_plan is not null and v_aud = 'client') or (v_plan is null and v_show);

  if p_parent_comment_id is not null then
    select c.visibility into v_vis from public.plan_item_comments c
     where c.id = p_parent_comment_id and c.item_id = p_item_id
       and c.deleted_at is null and c.parent_comment_id is null;
    if v_vis is null then raise exception 'invalid_payload'; end if;
  else
    v_vis := p_visibility;
  end if;
  if v_vis is null or v_vis not in ('everyone','team') then raise exception 'invalid_payload'; end if;
  if not v_agency then
    if not v_client_sees then raise exception 'forbidden_role'; end if;
    if v_vis <> 'everyone' then raise exception 'forbidden_role'; end if;
  end if;

  v_n := coalesce(array_length(p_attachment_version_ids, 1), 0);
  if p_body is null or char_length(btrim(p_body)) > 5000
     or (char_length(btrim(p_body)) = 0 and v_n = 0) then raise exception 'invalid_payload'; end if;

  select coalesce(array_agg(distinct s.x), '{}'::uuid[]) into v_mentioned from (
    select lower(t[1])::uuid x
      from regexp_matches(p_body, '@\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]', 'g') t
  ) s where s.x <> auth.uid();
  select array_agg(m) into v_invalid from unnest(v_mentioned) m
   where not exists (select 1 from public.workspace_members wm
                      where wm.workspace_id = v_ws and wm.user_id = m and wm.active = true
                        and (wm.role = any (array['owner','admin','agency'])
                             or (v_vis = 'everyone' and v_client_sees and wm.role = 'client')));
  if v_invalid is not null then
    raise exception 'invalid_mention' using detail = array_to_string(v_invalid, ',');
  end if;

  if v_n > 0 then
    if exists (select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
                where v.id = any (p_attachment_version_ids) and v.workspace_id = v_ws
                  and (a.origin = 'chat' or a.deleted_at is not null)) then
      raise exception 'attachment not available'; end if;
    if (select count(*) from public.asset_versions av join public.assets a on a.id = av.asset_id
         where av.id = any (p_attachment_version_ids) and av.workspace_id = v_ws
           and a.deleted_at is null) <> v_n then raise exception 'invalid_payload'; end if;
  end if;

  begin
    insert into public.plan_item_comments
      (workspace_id, item_id, author_user_id, body, visibility, parent_comment_id, attachment_asset_ids)
    values (v_ws, p_item_id, auth.uid(), btrim(p_body), v_vis, p_parent_comment_id,
            case when v_n > 0 then p_attachment_version_ids end)
    returning id into v_id;
    if v_n > 0 then
      insert into public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      select av.asset_id, av.id, 'plan_item_comment', v_id::text, v_ws, (u.ord - 1)::int, auth.uid()
        from unnest(p_attachment_version_ids) with ordinality as u(version_id, ord)
        join public.asset_versions av on av.id = u.version_id;
    end if;
  exception when check_violation or not_null_violation or foreign_key_violation then
    raise exception 'invalid_payload';
  end;

  if p_parent_comment_id is null then
    perform public._plan_item_notify_except(p_item_id, 'plan_comment', v_vis = 'team',
      jsonb_build_object('comment_id', v_id, 'visibility', v_vis), v_mentioned);
  else
    insert into public.inbox_entries
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select wm.user_id, v_ws, 'plan_comment', 'plan_item', p_item_id::text, 'posts',
           coalesce(v_plan::text, 'bank'), 'active',
           jsonb_build_object('comment_id', v_id, 'visibility', v_vis, 'plan_id', v_plan,
                              'root_comment_id', p_parent_comment_id), auth.uid()
      from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.active = true and wm.user_id <> auth.uid()
       and wm.user_id <> all (v_mentioned)
       and wm.user_id <> all (public._induction_sample_people())
       and wm.user_id in (select c.author_user_id from public.plan_item_comments c
                           where (c.id = p_parent_comment_id or c.parent_comment_id = p_parent_comment_id)
                             and c.deleted_at is null and c.author_user_id is not null)
       and (wm.role = any (array['owner','admin','agency'])
            or (v_vis = 'everyone' and v_client_sees and wm.role = 'client'));
  end if;

  if array_length(v_mentioned, 1) is not null then
    insert into public.inbox_entries
      (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select wm.user_id, v_ws, 'mention', 'plan_item', p_item_id::text, 'posts',
           coalesce(v_plan::text, 'bank'), 'urgent',
           jsonb_build_object('comment_id', v_id, 'visibility', v_vis, 'plan_id', v_plan,
                              'root_comment_id', p_parent_comment_id), auth.uid()
      from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.active = true and wm.user_id = any (v_mentioned);
  end if;

  perform public.audit_log_write(p_action=>'plan_item_comment_send', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('comment_id', v_id, 'visibility', v_vis,
      'reply', p_parent_comment_id is not null, 'files', v_n,
      'mentions', coalesce(array_length(v_mentioned, 1), 0)));
  return v_id;
end $function$;
revoke all on function public.plan_item_comment_send(uuid, uuid, text, text, uuid[], uuid) from public, anon;
grant execute on function public.plan_item_comment_send(uuid, uuid, text, text, uuid[], uuid) to authenticated;

create or replace function public.plan_item_comment_thread_read_set(p_root_id uuid, p_trace_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_vis text; v_item uuid; v_at timestamptz;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  select c.workspace_id, c.visibility, c.item_id into v_ws, v_vis, v_item
    from public.plan_item_comments c
   where c.id = p_root_id and c.parent_comment_id is null and c.deleted_at is null
     and public.is_active_workspace_member(c.workspace_id);
  if v_ws is null then raise exception 'comment not found'; end if;
  if not public.is_agency_side_member(v_ws) then
    if v_vis <> 'everyone' or not exists (
         select 1 from public.plan_items i left join public.plans p on p.id = i.plan_id and p.deleted_at is null
          where i.id = v_item and i.deleted_at is null
            and ((p.id is not null and p.audience = 'client') or (i.plan_id is null and i.show_to_client)))
    then raise exception 'comment not found'; end if;
  end if;
  select max(r.created_at) into v_at from public.plan_item_comments r
   where (r.id = p_root_id or r.parent_comment_id = p_root_id) and r.deleted_at is null;
  insert into public.plan_item_comment_thread_reads (root_comment_id, user_id, workspace_id, last_read_at)
  values (p_root_id, v_actor, v_ws, v_at)
  on conflict (root_comment_id, user_id) do update
    set last_read_at = excluded.last_read_at, updated_at = now()
    where excluded.last_read_at > public.plan_item_comment_thread_reads.last_read_at;
end $function$;
revoke all on function public.plan_item_comment_thread_read_set(uuid, uuid) from public, anon;
grant execute on function public.plan_item_comment_thread_read_set(uuid, uuid) to authenticated;
