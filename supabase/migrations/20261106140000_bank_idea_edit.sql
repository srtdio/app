-- Bank idea edit (6 Nov 2026). Applied live via the Supabase MCP on 6 Nov
-- 2026 before this file was written; the file is the record.
--
-- plan_concept_edit inner-joins plans, so a bank idea (plan_id null) could not
-- be edited at all: no title or description fix, no file added after creation.
-- bank_idea_edit is the bank's twin: title, description and (when a list is
-- sent) the files, replaced as plan_concept_edit replaces them. No date (a bank
-- idea gets its date when planned), no review reset (it has no reviews), no
-- Activity row (creators get added / moved / planned / shown / hidden; an edit
-- is none of those). last_active_at moves so the idea rises in Recently active
-- and the bank live ping (plan_items trigger) tells every open Bank.

CREATE OR REPLACE FUNCTION public.bank_idea_edit(
  p_item_id uuid, p_title text, p_description text,
  p_attachment_version_ids uuid[], p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text; v_plan uuid;
begin
  select i.workspace_id, i.kind, i.plan_id into v_ws, v_kind, v_plan
    from public.plan_items i
   where i.id = p_item_id and i.deleted_at is null for update of i;
  if v_ws is null or v_kind <> 'concept' or v_plan is not null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  begin
    update public.plan_items
       set title = btrim(p_title), description = nullif(btrim(p_description), ''),
           updated_at = now(), last_active_at = now()
     where id = p_item_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  if p_attachment_version_ids is not null then
    perform public._plan_check_versions(v_ws, p_attachment_version_ids);
    update public.asset_attachments set deleted_at = now()
     where entity_type = 'plan_item' and entity_id = p_item_id::text and deleted_at is null;
    perform public._plan_attach_versions(v_ws, p_item_id, p_attachment_version_ids);
  end if;
  perform public.audit_log_write(p_action=>'bank_idea_edit', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('files_changed', p_attachment_version_ids is not null));
end $function$;

REVOKE ALL ON FUNCTION public.bank_idea_edit(uuid, text, text, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_idea_edit(uuid, text, text, uuid[], uuid) TO authenticated;
