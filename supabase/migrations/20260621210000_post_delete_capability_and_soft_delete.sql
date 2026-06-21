-- Post delete capability + post_soft_delete proc.
-- ALREADY APPLIED to v2 via Supabase MCP. Record only; CI does not run this. Additive, nothing destructive.

insert into public.workspace_role_permissions (workspace_id, role, capability, allowed)
select w.id, r.role, 'post.delete', true
from public.workspaces w
cross join (values ('owner'),('admin')) as r(role)
on conflict (workspace_id, role, capability) do nothing;

create or replace function public.seed_workspace_role_defaults()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'owner', 'workspace.manage_billing', true),
    (new.id, 'owner', 'workspace.delete', true),
    (new.id, 'owner', 'workspace.transfer_ownership', true),
    (new.id, 'owner', 'workspace.manage_members', true),
    (new.id, 'owner', 'workspace.manage_settings', true),
    (new.id, 'owner', 'pipeline.view_all_stages', true),
    (new.id, 'owner', 'pipeline.bulk_actions', true),
    (new.id, 'owner', 'post.create', true),
    (new.id, 'owner', 'post.edit', true),
    (new.id, 'owner', 'post.approve', true),
    (new.id, 'owner', 'post.publish', true),
    (new.id, 'owner', 'post.delete', true),
    (new.id, 'owner', 'brief.view_all', true),
    (new.id, 'owner', 'brief.close', true),
    (new.id, 'owner', 'asset.upload', true),
    (new.id, 'owner', 'asset.delete', true),
    (new.id, 'owner', 'insights.view_full', true),
    (new.id, 'owner', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'admin', 'workspace.manage_members', true),
    (new.id, 'admin', 'workspace.manage_settings', true),
    (new.id, 'admin', 'pipeline.view_all_stages', true),
    (new.id, 'admin', 'pipeline.bulk_actions', true),
    (new.id, 'admin', 'post.create', true),
    (new.id, 'admin', 'post.edit', true),
    (new.id, 'admin', 'post.approve', true),
    (new.id, 'admin', 'post.publish', true),
    (new.id, 'admin', 'post.delete', true),
    (new.id, 'admin', 'brief.view_all', true),
    (new.id, 'admin', 'brief.close', true),
    (new.id, 'admin', 'asset.upload', true),
    (new.id, 'admin', 'asset.delete', true),
    (new.id, 'admin', 'insights.view_full', true),
    (new.id, 'admin', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'agency', 'pipeline.view_all_stages', true),
    (new.id, 'agency', 'pipeline.bulk_actions', true),
    (new.id, 'agency', 'post.create', true),
    (new.id, 'agency', 'post.edit', true),
    (new.id, 'agency', 'post.approve', true),
    (new.id, 'agency', 'post.publish', true),
    (new.id, 'agency', 'brief.view_all', true),
    (new.id, 'agency', 'brief.close', true),
    (new.id, 'agency', 'asset.upload', true),
    (new.id, 'agency', 'asset.delete', true),
    (new.id, 'agency', 'insights.view_full', true),
    (new.id, 'agency', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'client', 'pipeline.view_non_draft', true),
    (new.id, 'client', 'post.approve', true),
    (new.id, 'client', 'brief.view_own', true),
    (new.id, 'client', 'brief.create', true),
    (new.id, 'client', 'brief.close_own', true),
    (new.id, 'client', 'asset.upload', true),
    (new.id, 'client', 'insights.view_curated', true),
    (new.id, 'client', 'inbox.view', true);

  return new;
end;
$function$;

create or replace function public.post_soft_delete(p_post_id uuid, p_trace_id uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.posts where id=p_post_id and deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  if not public.proc_capability(v_ws, 'post.delete') then raise exception 'forbidden_role'; end if;
  update public.posts set deleted_at=now(), row_version=row_version+1 where id=p_post_id;
  perform public.audit_log_write('post_soft_delete','success',p_trace_id,v_ws,'post',p_post_id::text,'{}'::jsonb);
  return p_post_id;
end; $$;

revoke all on function public.post_soft_delete(uuid, uuid) from public;
grant execute on function public.post_soft_delete(uuid, uuid) to authenticated;
