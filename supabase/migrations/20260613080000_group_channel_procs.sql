-- Already applied to live DB via MCP; committed retroactively. Do NOT re-execute manually.
--
-- Group + channel procs (A2a). Six SECURITY DEFINER procs, search_path='',
-- EXECUTE granted to authenticated only (revoked from public, anon). Gating:
--   * group_create / dm_channel_ensure: active workspace member;
--   * group_rename / group_member_add / group_member_remove: group creator OR
--     workspace owner/admin;
--   * group_leave: self only.
-- The groups, group_members, chat_channels tables and the
-- public.is_active_workspace_member helper already exist from earlier migrations.

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
  RETURN v_group_id;
END; $function$
;

CREATE OR REPLACE FUNCTION public.group_rename(p_group_id uuid, p_name text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_creator uuid;
BEGIN
  SELECT workspace_id, created_by INTO v_ws, v_creator FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  BEGIN
    UPDATE public.groups SET name = p_name WHERE id = p_group_id;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'group_name_taken';
    WHEN check_violation THEN RAISE EXCEPTION 'group_name_invalid';
  END;
END; $function$
;

CREATE OR REPLACE FUNCTION public.group_member_add(p_group_id uuid, p_user_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_creator uuid;
BEGIN
  SELECT workspace_id, created_by INTO v_ws, v_creator FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = p_user_id AND active) THEN
    RAISE EXCEPTION 'member_not_in_workspace'; END IF;
  INSERT INTO public.group_members(group_id, user_id, workspace_id)
  VALUES (p_group_id, p_user_id, v_ws) ON CONFLICT DO NOTHING;
END; $function$
;

CREATE OR REPLACE FUNCTION public.group_member_remove(p_group_id uuid, p_user_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_creator uuid;
BEGIN
  SELECT workspace_id, created_by INTO v_ws, v_creator FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user_id;
END; $function$
;

CREATE OR REPLACE FUNCTION public.group_leave(p_group_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid();
END; $function$
;

CREATE OR REPLACE FUNCTION public.dm_channel_ensure(p_workspace_id uuid, p_other_user_id uuid, p_trace_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_a uuid; v_b uuid; v_channel_id text;
BEGIN
  IF p_other_user_id = auth.uid() THEN RAISE EXCEPTION 'cannot_dm_self'; END IF;
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = p_workspace_id AND user_id = p_other_user_id AND active) THEN
    RAISE EXCEPTION 'member_not_in_workspace'; END IF;
  v_a := least(auth.uid(), p_other_user_id);
  v_b := greatest(auth.uid(), p_other_user_id);
  v_channel_id := 'dm__' || p_workspace_id::text || '__' || v_a::text || '__' || v_b::text;
  INSERT INTO public.chat_channels(channel_id, workspace_id, channel_type, dm_user_a, dm_user_b)
  VALUES (v_channel_id, p_workspace_id, 'dm', v_a, v_b) ON CONFLICT (channel_id) DO NOTHING;
  RETURN v_channel_id;
END; $function$
;

-- Proc execution grants. authenticated may call every proc; never public or anon.
REVOKE ALL ON FUNCTION public.group_create(uuid, text, uuid[], uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.group_create(uuid, text, uuid[], uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.group_rename(uuid, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.group_rename(uuid, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.group_member_add(uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.group_member_add(uuid, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.group_member_remove(uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.group_member_remove(uuid, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.group_leave(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.group_leave(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.dm_channel_ensure(uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dm_channel_ensure(uuid, uuid, uuid) TO authenticated;
