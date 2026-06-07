-- Consolidated SECURITY DEFINER write procs for all sensitive writes.
-- Schema already applied to live (project movnexawfhsyuluspxoc). Do NOT execute.
--
-- Every sensitive write now flows through one of these procs. Each proc:
--   * gates the caller on public.is_active_workspace_member(workspace_id) where applicable;
--   * enforces role by looking the caller's capability up in public.workspace_role_permissions
--     (via public.proc_capability, a workspace-scoped lookup; public.has_capability is bound to
--     the JWT workspace_id() claim and so cannot authorize an explicitly-passed workspace);
--   * rejects only with the domain-named exceptions forbidden_role / invalid_stage_transition /
--     workspace_member_only / invalid_payload, never generic text;
--   * records the committed action with public.audit_log_write(p_action => <proc name>,
--     p_outcome => 'success', p_trace_id => <supplied>). Rejections raise and roll back, so the
--     success row is the only audit row that can persist; no failure-path audit calls are made.
--
-- post_version_create and annotation_create are append-only (INSERT only). briefs are read-only
-- after creation: brief_create inserts; brief_close only flips open -> closed.

-- ---------------------------------------------------------------------------
-- Workspace-scoped capability lookup against workspace_role_permissions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proc_capability(p_workspace_id uuid, p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT wrp.allowed
    FROM public.workspace_role_permissions wrp
    JOIN public.workspace_members wm
      ON wm.workspace_id = wrp.workspace_id AND wm.role = wrp.role
    WHERE wm.user_id = auth.uid()
      AND wm.workspace_id = p_workspace_id
      AND wm.active = true
      AND wrp.capability = p_capability
    LIMIT 1
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- stage_transition: enforces the locked stage map. Transitions that decide a
-- post (-> approved | rejected) require post.approve; the rest require post.edit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ws uuid;
  v_from text;
  v_cap text;
  v_ok boolean;
BEGIN
  SELECT workspace_id, stage INTO v_ws, v_from
  FROM public.posts
  WHERE id = p_post_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF NOT public.is_active_workspace_member(v_ws) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  v_ok := (v_from = 'draft'    AND p_to_stage IN ('review', 'parked'))
       OR (v_from = 'review'   AND p_to_stage IN ('approved', 'rejected', 'parked'))
       OR (v_from = 'approved' AND p_to_stage IN ('parked', 'rejected'))
       OR (v_from = 'parked'   AND p_to_stage = 'review')
       OR (v_from = 'rejected' AND p_to_stage = 'review');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'invalid_stage_transition';
  END IF;

  v_cap := CASE WHEN p_to_stage IN ('approved', 'rejected') THEN 'post.approve' ELSE 'post.edit' END;
  IF NOT public.proc_capability(v_ws, v_cap) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  UPDATE public.posts
  SET stage = p_to_stage, row_version = row_version + 1
  WHERE id = p_post_id;

  PERFORM public.audit_log_write(
    p_action => 'stage_transition', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => v_ws, p_entity_type => 'post', p_entity_id => p_post_id::text,
    p_payload => jsonb_build_object('from', v_from, 'to', p_to_stage));
  RETURN p_post_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- post_version_create: append-only snapshot. Next version_number under a row
-- lock on the post so concurrent callers serialize. Requires post.edit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_version_create(p_post_id uuid, p_snapshot jsonb, p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ws uuid;
  v_n integer;
  v_id uuid;
BEGIN
  SELECT workspace_id INTO v_ws
  FROM public.posts
  WHERE id = p_post_id AND deleted_at IS NULL
  FOR UPDATE;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF NOT public.is_active_workspace_member(v_ws) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF NOT public.proc_capability(v_ws, 'post.edit') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT coalesce(max(version_number), 0) + 1 INTO v_n
  FROM public.post_versions
  WHERE post_id = p_post_id;

  INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
  VALUES (p_post_id, v_ws, v_n, p_snapshot, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.audit_log_write(
    p_action => 'post_version_create', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => v_ws, p_entity_type => 'post_version', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('post_id', p_post_id, 'version_number', v_n));
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- annotation_create: append-only review marker. Any active member may annotate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.annotation_create(
  p_post_id uuid,
  p_post_version_id uuid,
  p_kind text,
  p_caption_start integer,
  p_caption_end integer,
  p_asset_attachment_id uuid,
  p_image_x real,
  p_image_y real,
  p_comment_id uuid,
  p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ws uuid;
  v_id uuid;
BEGIN
  SELECT workspace_id INTO v_ws
  FROM public.posts
  WHERE id = p_post_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF NOT public.is_active_workspace_member(v_ws) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF p_kind NOT IN ('caption_span', 'image_pin')
     OR p_comment_id IS NULL
     OR p_post_version_id IS NULL
     OR (p_kind = 'caption_span' AND (p_caption_start IS NULL OR p_caption_end IS NULL))
     OR (p_kind = 'image_pin' AND (p_image_x IS NULL OR p_image_y IS NULL OR p_asset_attachment_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  -- Normalize by kind: the post_annotations_caption_fields CHECK requires the
  -- fields of the other kind to be NULL, so only the relevant ones are stored.
  BEGIN
    INSERT INTO public.post_annotations (
      post_id, workspace_id, post_version_id, kind, caption_start, caption_end,
      asset_attachment_id, image_x, image_y, comment_id)
    VALUES (
      p_post_id, v_ws, p_post_version_id, p_kind,
      CASE WHEN p_kind = 'caption_span' THEN p_caption_start END,
      CASE WHEN p_kind = 'caption_span' THEN p_caption_end END,
      CASE WHEN p_kind = 'image_pin' THEN p_asset_attachment_id END,
      CASE WHEN p_kind = 'image_pin' THEN p_image_x END,
      CASE WHEN p_kind = 'image_pin' THEN p_image_y END,
      p_comment_id)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'annotation_create', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => v_ws, p_entity_type => 'post_annotation', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('post_id', p_post_id, 'kind', p_kind));
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- member_invite: workspace.manage_members. Resolves the invitee by email and
-- writes an inactive membership row that member_accept later activates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_invite(p_workspace_id uuid, p_email text, p_role text, p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id uuid;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF NOT public.proc_capability(p_workspace_id, 'workspace.manage_members') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF p_role NOT IN ('admin', 'agency', 'client') OR p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role, active, invited_by, invited_at)
    VALUES (p_workspace_id, v_uid, p_role, false, auth.uid(), now())
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation OR check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'member_invite', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => p_workspace_id, p_entity_type => 'workspace_member', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('role', p_role));
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- member_accept: only the invitee may accept, and only a pending invite row
-- (inactive, never accepted, not removed) is acceptable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_accept(p_invite_id uuid, p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ws uuid;
  v_user uuid;
  v_active boolean;
  v_accepted_at timestamptz;
  v_removed_at timestamptz;
BEGIN
  SELECT workspace_id, user_id, active, accepted_at, removed_at
  INTO v_ws, v_user, v_active, v_accepted_at, v_removed_at
  FROM public.workspace_members
  WHERE id = p_invite_id;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF v_user IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF v_active OR v_accepted_at IS NOT NULL OR v_removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  UPDATE public.workspace_members
  SET active = true, accepted_at = now()
  WHERE id = p_invite_id;

  PERFORM public.audit_log_write(
    p_action => 'member_accept', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => v_ws, p_entity_type => 'workspace_member', p_entity_id => p_invite_id::text);
  RETURN p_invite_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- brief_create: brief.create. Inserts only; briefs are read-only afterward.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.brief_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_title text;
  v_obj text;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF NOT public.proc_capability(p_workspace_id, 'brief.create') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  v_title := p_payload->>'title';
  v_obj := p_payload->>'objective';
  IF v_title IS NULL OR v_obj IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  BEGIN
    INSERT INTO public.briefs (
      workspace_id, title, objective, format_requested, brand_requirements,
      target_date, reference_links, created_by, created_via)
    VALUES (
      p_workspace_id, v_title, v_obj, p_payload->>'format_requested', p_payload->>'brand_requirements',
      (p_payload->>'target_date')::date, p_payload->'reference_links', auth.uid(),
      coalesce(p_payload->>'created_via', 'app'))
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'brief_create', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => p_workspace_id, p_entity_type => 'brief', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('title', v_title));
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- brief_close: brief.close, or brief.close_own on a brief the caller created.
-- Flips open -> closed only; no other brief field is editable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.brief_close(p_brief_id uuid, p_trace_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ws uuid;
  v_creator uuid;
  v_status text;
BEGIN
  SELECT workspace_id, created_by, status INTO v_ws, v_creator, v_status
  FROM public.briefs
  WHERE id = p_brief_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF NOT public.is_active_workspace_member(v_ws) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF NOT (public.proc_capability(v_ws, 'brief.close')
          OR (public.proc_capability(v_ws, 'brief.close_own') AND v_creator = auth.uid())) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  UPDATE public.briefs
  SET status = 'closed', closed_at = now(), closed_by = auth.uid(), row_version = row_version + 1
  WHERE id = p_brief_id;

  PERFORM public.audit_log_write(
    p_action => 'brief_close', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => v_ws, p_entity_type => 'brief', p_entity_id => p_brief_id::text);
END;
$$;

-- ---------------------------------------------------------------------------
-- comment_create: any active member; author is auth.uid(). entity_type post|brief.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comment_create(
  p_workspace_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_parent_comment_id uuid,
  p_body text,
  p_mentions jsonb,
  p_attachment_asset_ids uuid[],
  p_is_decision boolean,
  p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF p_entity_type NOT IN ('post', 'brief')
     OR p_entity_id IS NULL
     OR p_body IS NULL
     OR length(p_body) < 1
     OR length(p_body) > 10000 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  BEGIN
    INSERT INTO public.comments (
      workspace_id, entity_type, entity_id, parent_comment_id, author_user_id,
      body, mentions, attachment_asset_ids, is_decision)
    VALUES (
      p_workspace_id, p_entity_type, p_entity_id, p_parent_comment_id, auth.uid(),
      p_body, p_mentions, p_attachment_asset_ids, coalesce(p_is_decision, false))
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'comment_create', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => p_workspace_id, p_entity_type => 'comment', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('entity_type', p_entity_type, 'is_decision', coalesce(p_is_decision, false)));
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- inbox_entry_create: server-side notification fan-out. Caller must be an active
-- member of the target workspace. Not granted to authenticated; service-role /
-- definer callers only (no client-facing wrapper).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inbox_entry_create(
  p_user_id uuid,
  p_workspace_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_scope text,
  p_scope_key text,
  p_tier text,
  p_payload jsonb,
  p_trace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF p_user_id IS NULL OR p_event_type IS NULL OR p_scope IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  BEGIN
    INSERT INTO public.inbox_entries (
      user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload)
    VALUES (
      p_user_id, p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_scope, p_scope_key,
      coalesce(p_tier, 'active'), coalesce(p_payload, '{}'::jsonb))
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'inbox_entry_create', p_outcome => 'success', p_trace_id => p_trace_id,
    p_workspace_id => p_workspace_id, p_entity_type => 'inbox_entry', p_entity_id => v_id::text,
    p_payload => jsonb_build_object('event_type', p_event_type));
  RETURN v_id;
END;
$$;

-- ===========================================================================
-- Lock down direct writes on the sensitive tables: the authenticated role may
-- no longer INSERT/UPDATE/DELETE; SELECT stays governed by existing RLS. Every
-- write goes through the SECURITY DEFINER procs above.
-- ===========================================================================
REVOKE INSERT, UPDATE, DELETE ON
  public.posts,
  public.post_versions,
  public.post_annotations,
  public.comments,
  public.briefs,
  public.workspace_members,
  public.assets,
  public.asset_versions,
  public.asset_attachments,
  public.inbox_entries
FROM authenticated;

-- ===========================================================================
-- Proc execution grants. authenticated may call every client-facing proc;
-- never public or anon. inbox_entry_create is intentionally NOT granted to
-- authenticated (server / service-role callers only).
-- ===========================================================================
REVOKE ALL ON FUNCTION public.proc_capability(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.proc_capability(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.stage_transition(uuid, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.stage_transition(uuid, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.post_version_create(uuid, jsonb, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.post_version_create(uuid, jsonb, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.annotation_create(uuid, uuid, text, integer, integer, uuid, real, real, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.annotation_create(uuid, uuid, text, integer, integer, uuid, real, real, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.member_invite(uuid, text, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.member_invite(uuid, text, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.member_accept(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.member_accept(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.brief_create(uuid, jsonb, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.brief_create(uuid, jsonb, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.brief_close(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.brief_close(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.comment_create(uuid, text, uuid, uuid, text, jsonb, uuid[], boolean, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.comment_create(uuid, text, uuid, uuid, text, jsonb, uuid[], boolean, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.inbox_entry_create(uuid, uuid, text, text, text, text, text, text, jsonb, uuid) FROM public, anon, authenticated;
