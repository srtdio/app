-- Schema already applied via MCP (project movnexawfhsyuluspxoc). Recorded for parity only; idempotent.
-- One chat group per workspace free; more only after workspaces.group_allowance is raised by SQL.
-- Operator-owned workspaces are unlimited; induction sample groups never count.

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS group_allowance integer NOT NULL DEFAULT 1 CONSTRAINT workspaces_group_allowance_min CHECK (group_allowance >= 1);

CREATE OR REPLACE FUNCTION public.group_limit_allows(p_workspace_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT public.is_active_workspace_member(p_workspace_id) AND (
    EXISTS (SELECT 1 FROM public.workspaces w JOIN public.platform_operators po ON po.user_id = w.owner_user_id AND po.revoked_at IS NULL WHERE w.id = p_workspace_id)
    OR (SELECT count(*) FROM public.groups g WHERE g.workspace_id = p_workspace_id AND g.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.induction_sample_rows s WHERE s.workspace_id = g.workspace_id AND s.kind = 'group' AND s.row_id = g.id::text))
       < (SELECT w.group_allowance FROM public.workspaces w WHERE w.id = p_workspace_id));
$function$;

REVOKE ALL ON FUNCTION public.group_limit_allows(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.group_limit_allows(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.group_create(p_workspace_id uuid, p_name text, p_member_user_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_group_id uuid; v_channel_id text;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace_groups:' || p_workspace_id::text, 0));
  IF NOT public.group_limit_allows(p_workspace_id) THEN RAISE EXCEPTION 'group_limit_reached' USING HINT = 'free_plan_one_group'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_member_user_ids,'{}'::uuid[])) AS u
    WHERE NOT EXISTS (SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = p_workspace_id AND wm.user_id = u AND wm.active)) THEN
    RAISE EXCEPTION 'member_not_in_workspace'; END IF;
  BEGIN
    INSERT INTO public.groups(workspace_id, name, created_by)
    VALUES (p_workspace_id, p_name, auth.uid()) RETURNING id INTO v_group_id;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'group_name_taken';
    WHEN check_violation THEN RAISE EXCEPTION 'group_name_invalid';
  END;
  INSERT INTO public.group_members(group_id, user_id, workspace_id)
  SELECT v_group_id, m, p_workspace_id
  FROM (SELECT auth.uid() AS m UNION SELECT unnest(coalesce(p_member_user_ids,'{}'::uuid[]))) s
  ON CONFLICT DO NOTHING;
  v_channel_id := 'group__' || p_workspace_id::text || '__' || v_group_id::text;
  INSERT INTO public.chat_channels(channel_id, workspace_id, channel_type, entity_id)
  VALUES (v_channel_id, p_workspace_id, 'group', v_group_id);
  PERFORM public.audit_log_write(p_action=>'group_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'group', p_entity_id=>v_group_id::text,
    p_payload=>jsonb_build_object('name', p_name, 'member_user_ids', to_jsonb(coalesce(p_member_user_ids,'{}'::uuid[]))));
  RETURN v_group_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.capabilities_for_workspace(p_trace_id uuid, p_workspace_id uuid)
 RETURNS TABLE(capability text, allowed boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT wrp.capability, wrp.allowed FROM public.workspace_role_permissions wrp
    JOIN public.workspace_members wm ON wm.workspace_id = wrp.workspace_id AND wm.role = wrp.role
   WHERE wm.workspace_id = p_workspace_id AND wm.user_id = (SELECT auth.uid()) AND wm.active = true
  UNION ALL SELECT 'group.create_more', public.group_limit_allows(p_workspace_id)
$function$;
