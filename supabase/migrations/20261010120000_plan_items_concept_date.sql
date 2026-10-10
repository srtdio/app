BEGIN;
ALTER TABLE public.plan_items ADD COLUMN target_date date;
ALTER TABLE public.plan_items ADD CONSTRAINT plan_items_target_date_concept_only
  CHECK (kind = 'concept' OR target_date IS NULL);

DROP FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid);
CREATE FUNCTION public.plan_concept_add(p_plan_id uuid, p_title text, p_description text,
  p_attachment_version_ids uuid[], p_trace_id uuid, p_target_date date DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_ws uuid; v_id uuid; v_pos int;
begin
  select workspace_id into v_ws from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  perform public._plan_check_versions(v_ws, p_attachment_version_ids);
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  begin
    insert into public.plan_items (workspace_id, plan_id, kind, position, title, description, target_date, created_by)
    values (v_ws, p_plan_id, 'concept', v_pos, btrim(p_title), nullif(btrim(p_description), ''), p_target_date, auth.uid())
    returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public._plan_attach_versions(v_ws, v_id, p_attachment_version_ids);
  perform public.audit_log_write(p_action=>'plan_concept_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('plan_id', p_plan_id, 'attachments', coalesce(cardinality(p_attachment_version_ids), 0), 'target_date', p_target_date));
  return v_id;
end $function$;

DROP FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid);
CREATE FUNCTION public.plan_concept_edit(p_item_id uuid, p_title text, p_description text,
  p_attachment_version_ids uuid[], p_trace_id uuid, p_target_date date DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text;
begin
  select workspace_id, kind into v_ws, v_kind from public.plan_items where id = p_item_id and deleted_at is null for update;
  if v_ws is null or v_kind <> 'concept' then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  begin
    update public.plan_items set title = btrim(p_title), description = nullif(btrim(p_description), ''),
           target_date = p_target_date, updated_at = now()
     where id = p_item_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  if p_attachment_version_ids is not null then
    perform public._plan_check_versions(v_ws, p_attachment_version_ids);
    update public.asset_attachments set deleted_at = now()
     where entity_type = 'plan_item' and entity_id = p_item_id::text and deleted_at is null;
    perform public._plan_attach_versions(v_ws, p_item_id, p_attachment_version_ids);
  end if;
  update public.plan_item_reviews set status = 'waiting', reviewed_by = auth.uid(), reviewed_at = now()
   where item_id = p_item_id and status <> 'waiting';
  perform public.audit_log_write(p_action=>'plan_concept_edit', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('files_changed', p_attachment_version_ids is not null, 'target_date', p_target_date));
end $function$;

REVOKE ALL ON FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid, date) TO authenticated;
COMMIT;
