-- Record of a schema change ALREADY APPLIED LIVE on movnexawfhsyuluspxoc.
-- "Approved on behalf of": an agency-side member approves a post on behalf of an
-- active client member. Idempotent; mirrors live exactly (function bodies copied
-- verbatim from pg_get_functiondef). No DROP.

alter table public.posts add column if not exists approved_on_behalf_of uuid null references public.users(id) on delete set null;

create index if not exists posts_approved_on_behalf_of_idx on public.posts(approved_on_behalf_of) where approved_on_behalf_of is not null;

CREATE OR REPLACE FUNCTION public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid, p_on_behalf_of uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ws uuid; v_from text; v_cap text; v_ok boolean; v_closed int := 0; v_role text;
begin
  select workspace_id, stage into v_ws, v_from from public.posts where id=p_post_id and deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  v_ok := (v_from='draft' and p_to_stage in ('review','parked'))
       or (v_from='review' and p_to_stage in ('approved','rejected','parked'))
       or (v_from='approved' and p_to_stage in ('parked','rejected'))
       or (v_from='parked' and p_to_stage='review')
       or (v_from='rejected' and p_to_stage='review');
  if not v_ok then raise exception 'invalid_stage_transition'; end if;
  v_cap := case when p_to_stage in ('approved','rejected') then 'post.approve' else 'post.edit' end;
  if not public.proc_capability(v_ws, v_cap) then raise exception 'forbidden_role'; end if;
  select wm.role into v_role from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true;
  if p_on_behalf_of is not null then
    if p_to_stage <> 'approved' or v_role = 'client' or p_on_behalf_of = auth.uid() then raise exception 'invalid_on_behalf'; end if;
    if not exists (select 1 from public.workspace_members wm where wm.workspace_id = v_ws
                   and wm.user_id = p_on_behalf_of and wm.active = true and wm.role = 'client') then
      raise exception 'invalid_on_behalf'; end if;
  end if;
  update public.posts
     set stage=p_to_stage, stage_entered_at=now(), row_version=row_version+1,
         approved_by = case when p_to_stage='approved' then auth.uid() when v_from='approved' then null else approved_by end,
         approved_at = case when p_to_stage='approved' then now() when v_from='approved' then null else approved_at end,
         approved_on_behalf_of = case when p_to_stage='approved' then p_on_behalf_of when v_from='approved' then null else approved_on_behalf_of end
   where id=p_post_id;
  if p_to_stage = 'approved' then
    update public.comments set closed_at = now(), closed_by = auth.uid()
     where entity_type = 'post' and entity_id = p_post_id and ledger_seq is not null
       and deleted_at is null and accepted_at is null and closed_at is null;
    get diagnostics v_closed = row_count;
  elsif v_from = 'approved' then
    update public.comments set closed_at = null, closed_by = null
     where entity_type = 'post' and entity_id = p_post_id and ledger_seq is not null and closed_at is not null;
  end if;
  perform public.audit_log_write('stage_transition','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('from',v_from,'to',p_to_stage,'checkpoints_closed',v_closed,'actor_role',v_role),
          p_on_behalf_of => p_on_behalf_of);
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage, 'actor_role', v_role, 'on_behalf_of', p_on_behalf_of), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id=v_ws and wm.active = true and wm.user_id <> auth.uid();
  return p_post_id;
end; $function$;

revoke all on function public.stage_transition(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.stage_transition(uuid, text, uuid, uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.stage_transition(p_post_id, p_to_stage, p_trace_id, null::uuid);
$function$;
