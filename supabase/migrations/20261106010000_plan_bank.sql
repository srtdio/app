BEGIN;
ALTER TABLE public.plan_items ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE public.plan_items
  ADD COLUMN show_to_client boolean NOT NULL DEFAULT false,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN starred_at timestamptz,
  ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN came_from_plan_title text;
ALTER TABLE public.plan_items ADD CONSTRAINT plan_items_bank_concept_only
  CHECK (plan_id IS NOT NULL OR kind = 'concept');
ALTER TABLE public.plan_items ADD CONSTRAINT plan_items_bank_flags_only
  CHECK (plan_id IS NULL OR (archived_at IS NULL AND show_to_client = false));
CREATE INDEX plan_items_bank_idx ON public.plan_items (workspace_id, last_active_at DESC)
  WHERE plan_id IS NULL AND deleted_at IS NULL;
CREATE TABLE public.plan_item_buckets (
  item_id uuid NOT NULL REFERENCES public.plan_items(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES public.workspace_buckets(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, bucket_id));
CREATE INDEX plan_item_buckets_bucket_idx ON public.plan_item_buckets (workspace_id, bucket_id);
ALTER TABLE public.plan_item_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_item_buckets_select_member ON public.plan_item_buckets FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plan_items i WHERE i.id = plan_item_buckets.item_id));
REVOKE ALL ON public.plan_item_buckets FROM anon, service_role, authenticated;
GRANT SELECT ON public.plan_item_buckets TO authenticated;
ALTER POLICY plan_items_select_member ON public.plan_items USING (
  deleted_at IS NULL
  AND (kind = 'concept' OR EXISTS (SELECT 1 FROM public.posts po WHERE po.id = plan_items.post_id))
  AND (
    (plan_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_items.plan_id))
    OR (plan_id IS NULL
        AND EXISTS (SELECT 1 FROM public.workspace_members wm
                    WHERE wm.workspace_id = plan_items.workspace_id AND wm.user_id = auth.uid() AND wm.active)
        AND (show_to_client OR public.is_agency_side_member(plan_items.workspace_id)))));
CREATE FUNCTION public._plan_item_touch() RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN UPDATE public.plan_items SET last_active_at = now() WHERE id = NEW.item_id; RETURN NEW; END $$;
CREATE TRIGGER plan_item_comments_touch AFTER INSERT ON public.plan_item_comments
  FOR EACH ROW EXECUTE FUNCTION public._plan_item_touch();
CREATE FUNCTION public.bank_idea_create(p_workspace_id uuid, p_title text, p_description text,
  p_attachment_version_ids uuid[], p_bucket_ids uuid[], p_trace_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.is_agency_side_member(p_workspace_id) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  PERFORM public._plan_check_versions(p_workspace_id, p_attachment_version_ids);
  BEGIN
    INSERT INTO public.plan_items (workspace_id, plan_id, kind, position, title, description, created_by)
    VALUES (p_workspace_id, NULL, 'concept', 0, btrim(p_title), nullif(btrim(p_description), ''), auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation THEN RAISE EXCEPTION 'invalid_payload'; END;
  PERFORM public._plan_attach_versions(p_workspace_id, v_id, p_attachment_version_ids);
  INSERT INTO public.plan_item_buckets (item_id, bucket_id, workspace_id)
    SELECT v_id, b.id, p_workspace_id FROM public.workspace_buckets b
    WHERE b.workspace_id = p_workspace_id AND b.archived = false AND b.id = ANY(coalesce(p_bucket_ids, '{}'));
  PERFORM public.audit_log_write(p_action=>'bank_idea_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'plan_item', p_entity_id=>v_id::text);
  RETURN v_id;
END $$;
CREATE FUNCTION public.plan_item_to_bank(p_item_id uuid, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid; v_plan uuid; v_kind text; v_linked uuid; v_title text;
BEGIN
  SELECT workspace_id, plan_id, kind, linked_post_id INTO v_ws, v_plan, v_kind, v_linked
    FROM public.plan_items WHERE id = p_item_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL OR v_kind <> 'concept' OR v_plan IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_linked IS NOT NULL AND EXISTS (SELECT 1 FROM public.posts WHERE id = v_linked AND stage = 'approved')
    THEN RAISE EXCEPTION 'post_approved'; END IF;
  SELECT title INTO v_title FROM public.plans WHERE id = v_plan;
  UPDATE public.plan_items SET plan_id = NULL, target_date = NULL, came_from_plan_title = v_title,
    last_active_at = now(), updated_at = now() WHERE id = p_item_id;
  DELETE FROM public.plan_item_reviews WHERE item_id = p_item_id;
  PERFORM public.audit_log_write(p_action=>'plan_item_to_bank', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('from_plan_id', v_plan));
END $$;
CREATE FUNCTION public.plan_item_from_bank(p_item_id uuid, p_plan_id uuid, p_target_date date, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid; v_pws uuid; v_pos int; v_tz text;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.plan_items
    WHERE id = p_item_id AND deleted_at IS NULL AND plan_id IS NULL FOR UPDATE;
  SELECT workspace_id INTO v_pws FROM public.plans WHERE id = p_plan_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL OR v_pws IS NULL OR v_ws <> v_pws THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  SELECT timezone INTO v_tz FROM public.workspaces WHERE id = v_ws;
  IF p_target_date < (now() AT TIME ZONE coalesce(v_tz, 'UTC'))::date THEN RAISE EXCEPTION 'past_date'; END IF;
  SELECT coalesce(max(position), -1) + 1 INTO v_pos FROM public.plan_items WHERE plan_id = p_plan_id AND deleted_at IS NULL;
  UPDATE public.plan_items SET plan_id = p_plan_id, target_date = p_target_date, position = v_pos,
    archived_at = NULL, show_to_client = false, last_active_at = now(), updated_at = now() WHERE id = p_item_id;
  PERFORM public.audit_log_write(p_action=>'plan_item_from_bank', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('plan_id', p_plan_id, 'target_date', p_target_date));
END $$;
CREATE FUNCTION public.bank_idea_set(p_item_id uuid, p_show_to_client boolean, p_archived boolean, p_starred boolean, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.plan_items
    WHERE id = p_item_id AND deleted_at IS NULL AND plan_id IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.plan_items SET
    show_to_client = coalesce(p_show_to_client, show_to_client),
    archived_at = CASE WHEN p_archived IS NULL THEN archived_at WHEN p_archived THEN coalesce(archived_at, now()) ELSE NULL END,
    starred_at  = CASE WHEN p_starred IS NULL THEN starred_at WHEN p_starred THEN coalesce(starred_at, now()) ELSE NULL END,
    updated_at = now()
  WHERE id = p_item_id;
  PERFORM public.audit_log_write(p_action=>'bank_idea_set', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('show_to_client', p_show_to_client, 'archived', p_archived, 'starred', p_starred));
END $$;
CREATE FUNCTION public.plan_item_buckets_set(p_item_id uuid, p_bucket_ids uuid[], p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.plan_items WHERE id = p_item_id AND deleted_at IS NULL AND kind = 'concept' FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  DELETE FROM public.plan_item_buckets WHERE item_id = p_item_id;
  INSERT INTO public.plan_item_buckets (item_id, bucket_id, workspace_id)
    SELECT p_item_id, b.id, v_ws FROM public.workspace_buckets b
    WHERE b.workspace_id = v_ws AND b.archived = false AND b.id = ANY(coalesce(p_bucket_ids, '{}'));
  UPDATE public.plan_items SET last_active_at = now(), updated_at = now() WHERE id = p_item_id;
  PERFORM public.audit_log_write(p_action=>'plan_item_buckets_set', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text);
END $$;
CREATE FUNCTION public.workspace_bucket_rename(p_bucket_id uuid, p_name text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid; v_name text := btrim(p_name);
BEGIN
  SELECT workspace_id INTO v_ws FROM public.workspace_buckets WHERE id = p_bucket_id AND archived = false FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_name IS NULL OR char_length(v_name) < 1 OR char_length(v_name) > 40 THEN RAISE EXCEPTION 'invalid_name'; END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_buckets WHERE workspace_id = v_ws AND archived = false AND id <> p_bucket_id AND lower(name) = lower(v_name))
    THEN RAISE EXCEPTION 'name_taken'; END IF;
  UPDATE public.workspace_buckets SET name = v_name WHERE id = p_bucket_id;
  PERFORM public.audit_log_write(p_action=>'workspace_bucket_rename', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'workspace_bucket', p_entity_id=>p_bucket_id::text);
END $$;
CREATE FUNCTION public.workspace_bucket_delete(p_bucket_id uuid, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid; v_n int;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.workspace_buckets WHERE id = p_bucket_id AND archived = false FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  DELETE FROM public.plan_item_buckets WHERE bucket_id = p_bucket_id; GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.workspace_buckets SET archived = true WHERE id = p_bucket_id;
  PERFORM public.audit_log_write(p_action=>'workspace_bucket_delete', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'workspace_bucket', p_entity_id=>p_bucket_id::text,
    p_payload=>jsonb_build_object('ideas_unlinked', v_n));
END $$;
REVOKE ALL ON FUNCTION public.bank_idea_create(uuid, text, text, uuid[], uuid[], uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.plan_item_to_bank(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.plan_item_from_bank(uuid, uuid, date, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_idea_set(uuid, boolean, boolean, boolean, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.plan_item_buckets_set(uuid, uuid[], uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workspace_bucket_rename(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workspace_bucket_delete(uuid, uuid) FROM PUBLIC, anon;
COMMIT;
