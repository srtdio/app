-- Applied live 19 Oct 2026 via MCP; this file is the record.
-- S2 workspace bucket create record: public.workspace_bucket_create(uuid, text, uuid).

CREATE OR REPLACE FUNCTION public.workspace_bucket_create(p_workspace_id uuid, p_name text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_name text := btrim(p_name); v_count integer; v_id uuid;
  v_colors text[] := array['#378ADD','#1D9E75','#D85A30','#7F77DD','#BA7517','#D4537E','#639922','#888780'];
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not exists (
    select 1 from public.workspace_members wm
    join public.workspace_role_permissions wrp on wrp.workspace_id = wm.workspace_id and wrp.role = wm.role
    where wm.workspace_id = p_workspace_id and wm.user_id = v_actor and wm.active = true
      and wrp.capability = 'post.create' and wrp.allowed = true
  ) then raise exception 'forbidden_role'; end if;
  if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 40 then raise exception 'invalid_name'; end if;
  if exists (select 1 from public.workspace_buckets where workspace_id = p_workspace_id and archived = false and lower(name) = lower(v_name))
    then raise exception 'name_taken'; end if;
  select count(*) into v_count from public.workspace_buckets where workspace_id = p_workspace_id and archived = false;
  insert into public.workspace_buckets (workspace_id, name, color_hex, position)
  values (p_workspace_id, v_name, v_colors[(v_count % 8) + 1], v_count)
  returning id into v_id;
  return v_id;
end $function$;

revoke execute on function public.workspace_bucket_create(uuid, text, uuid) from public;
grant execute on function public.workspace_bucket_create(uuid, text, uuid) to authenticated;
