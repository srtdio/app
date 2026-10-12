-- post_soft_delete: post_deleted now also reaches clients when a DRAFT post
-- sits in a live client plan (a non-draft already reached every member).
-- Applied live on movnexawfhsyuluspxoc (12 Oct); this file records the body
-- verbatim (pg_get_functiondef md5 86b609da48bc4a30f1238619857ee88d).
-- Rollback: re-apply the previous body, i.e. this one without the last
-- "or (wm.role = 'client' and exists (... plans pl ... audience = 'client'))"
-- branch of the recipient filter.

CREATE OR REPLACE FUNCTION public.post_soft_delete(p_post_id uuid, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ws uuid; v_role text; v_stage text;
begin
  select workspace_id, stage into v_ws, v_stage from public.posts where id=p_post_id and deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  if not public.proc_capability(v_ws, 'post.delete') then raise exception 'forbidden_role'; end if;
  select wm.role into v_role from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true;
  update public.posts set deleted_at=now(), row_version=row_version+1 where id=p_post_id;
  perform public.audit_log_write('post_soft_delete','success',p_trace_id,v_ws,'post',p_post_id::text,'{}'::jsonb);
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, 'post_deleted', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('number', p.number, 'title', left(coalesce(p.title, p.caption, ''), 120), 'actor_role', v_role),
         auth.uid()
    from public.workspace_members wm, public.posts p
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id <> auth.uid() and p.id = p_post_id
     and (v_stage <> 'draft'
          or exists (select 1 from public.workspace_role_permissions r
                      where r.workspace_id = v_ws and r.role = wm.role
                        and r.capability = 'pipeline.view_all_stages' and r.allowed = true)
          or (wm.role = 'client' and exists (
                select 1 from public.plan_items i join public.plans pl on pl.id = i.plan_id
                 where i.post_id = p_post_id and i.deleted_at is null
                   and pl.deleted_at is null and pl.audience = 'client')));
  return p_post_id;
end; $function$
;
