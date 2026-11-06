-- Applied out of band 6 Nov 2026 (PR D, idea bank Activity and catch-up email). No-op on movnexawfhsyuluspxoc.
--
-- Idea bank alerts. inbox_entries_event_type_check admits five new types:
-- bank_idea_added, bank_idea_moved, bank_idea_planned, bank_idea_shown,
-- bank_idea_hidden. _plan_items_change_notify returns early for plan-less
-- (bank) rows. _plan_item_notify_except left-joins plans: scope_key is 'bank'
-- for a plan-less item, clients are included when the plan is shared
-- (audience client) or the bank idea is show_to_client, and induction sample
-- people are left out. plan_item_comment_create left-joins plans too; a client
-- comments only on ideas they can see. bank_idea_create, plan_item_to_bank,
-- plan_item_from_bank and bank_idea_set each raise their event. Every
-- definition is copied verbatim from live (pg_get_constraintdef /
-- pg_get_functiondef, 6 Nov 2026). Grants are unchanged (CREATE OR REPLACE
-- keeps them). No table shapes change.
--
-- Rollback: delete inbox_entries rows whose event_type starts with
-- 'bank_idea_', re-add the CHECK without the five values, and restore the
-- previous function bodies from 20261106010000_plan_bank.sql and
-- 20261106100000_plan_bank_chat_bundle.sql.

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK ((event_type = ANY (ARRAY['comment'::text, 'mention'::text, 'stage_change'::text, 'comment_resolved'::text, 'brief_created'::text, 'brief_closed'::text, 'asset_uploaded'::text, 'asset_version_added'::text, 'invite'::text, 'trial_warning'::text, 'billing_failure'::text, 'system'::text, 'checkpoints_added'::text, 'post_ready'::text, 'checkpoint_reopened'::text, 'checkpoint_asked'::text, 'scheduled_sent'::text, 'scheduled_failed'::text, 'reminder'::text, 'post_deleted'::text, 'assets_deleted'::text, 'plan_comment'::text, 'plan_review'::text, 'plan_opened'::text, 'plan_deleted'::text, 'plan_date_changed'::text, 'plan_updated'::text, 'task_changed'::text, 'task_due'::text, 'brief_post_created'::text, 'bank_idea_added'::text, 'bank_idea_moved'::text, 'bank_idea_planned'::text, 'bank_idea_shown'::text, 'bank_idea_hidden'::text])));

CREATE OR REPLACE FUNCTION public._plan_items_change_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Bank rows (no plan) have no plan to notify; the bank's own alerts come separately.
  if coalesce(new.plan_id, old.plan_id) is null then return null; end if;
  if tg_op = 'INSERT' then
    perform public._plan_notify(new.plan_id, 'plan_updated',
      jsonb_build_object('kind', 'slot_added', 'item_id', new.id));
  elsif old.deleted_at is null and new.deleted_at is not null then
    -- A post leaving the plan by date is already announced by posts_plan_day_sync.
    if coalesce(current_setting('app.plan_day_sync', true), '') <> 'on' then
      perform public._plan_notify(new.plan_id, 'plan_updated',
        jsonb_build_object('kind', 'slot_removed', 'item_id', new.id, 'post_id', new.post_id, 'title', new.title));
    end if;
  elsif new.deleted_at is null and new.kind = 'concept'
        and (old.title is distinct from new.title or old.description is distinct from new.description) then
    perform public._plan_notify(new.plan_id, 'plan_updated',
      jsonb_build_object('kind', 'concept_changed', 'item_id', new.id));
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public._plan_item_notify_except(p_item_id uuid, p_event_type text, p_team_only boolean, p_payload jsonb, p_exclude uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_plan uuid; v_show boolean; v_client boolean;
begin
  select i.workspace_id, p.audience, p.id, i.show_to_client into v_ws, v_aud, v_plan, v_show
    from public.plan_items i left join public.plans p on p.id = i.plan_id where i.id = p_item_id;
  if v_ws is null then return; end if;
  v_client := not p_team_only and ((v_plan is not null and v_aud = 'client') or (v_plan is null and v_show));
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, p_event_type, 'plan_item', p_item_id::text, 'posts', coalesce(v_plan::text, 'bank'), 'active',
         p_payload || jsonb_build_object('plan_id', v_plan), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id <> auth.uid()
     and wm.user_id <> all (coalesce(p_exclude, '{}'::uuid[]))
     and wm.user_id <> all (public._induction_sample_people())
     and (wm.role = any (array['owner','admin','agency']) or (v_client and wm.role = 'client'));
end $function$;

CREATE OR REPLACE FUNCTION public.plan_item_comment_create(p_item_id uuid, p_body text, p_visibility text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_plan uuid; v_show boolean; v_agency boolean; v_id uuid; v_mentioned uuid[]; v_invalid uuid[]; v_client_sees boolean;
begin
  select i.workspace_id, p.audience, p.id, i.show_to_client into v_ws, v_aud, v_plan, v_show
    from public.plan_items i left join public.plans p on p.id = i.plan_id and p.deleted_at is null
   where i.id = p_item_id and i.deleted_at is null and (i.plan_id is null or p.id is not null);
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  if p_visibility not in ('everyone','team') then raise exception 'invalid_payload'; end if;
  v_agency := public.is_agency_side_member(v_ws);
  v_client_sees := (v_plan is not null and v_aud = 'client') or (v_plan is null and v_show);
  if not v_agency then
    if not v_client_sees then raise exception 'forbidden_role'; end if;
    if p_visibility <> 'everyone' then raise exception 'forbidden_role'; end if;
  end if;
  select coalesce(array_agg(distinct s.x), '{}'::uuid[]) into v_mentioned from (
    select lower(t[1])::uuid x
      from regexp_matches(coalesce(p_body, ''), '@\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]', 'g') t
  ) s where s.x <> auth.uid();
  select array_agg(m) into v_invalid from unnest(v_mentioned) m
   where not exists (select 1 from public.workspace_members wm
                      where wm.workspace_id = v_ws and wm.user_id = m and wm.active = true
                        and (wm.role = any (array['owner','admin','agency'])
                             or (p_visibility = 'everyone' and v_client_sees and wm.role = 'client')));
  if v_invalid is not null then
    raise exception 'invalid_mention' using detail = array_to_string(v_invalid, ',');
  end if;
  begin
    insert into public.plan_item_comments (workspace_id, item_id, author_user_id, body, visibility)
    values (v_ws, p_item_id, auth.uid(), btrim(p_body), p_visibility) returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public._plan_item_notify_except(p_item_id, 'plan_comment', p_visibility = 'team',
    jsonb_build_object('comment_id', v_id, 'visibility', p_visibility), v_mentioned);
  if array_length(v_mentioned, 1) is not null then
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select wm.user_id, v_ws, 'mention', 'plan_item', p_item_id::text, 'posts', coalesce(v_plan::text, 'bank'), 'urgent',
           jsonb_build_object('comment_id', v_id, 'visibility', p_visibility, 'plan_id', v_plan), auth.uid()
      from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.active = true and wm.user_id = any (v_mentioned);
  end if;
  perform public.audit_log_write(p_action=>'plan_item_comment_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('comment_id', v_id, 'visibility', p_visibility, 'mentions', coalesce(array_length(v_mentioned, 1), 0)));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.bank_idea_create(p_workspace_id uuid, p_title text, p_description text, p_attachment_version_ids uuid[], p_bucket_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  PERFORM public._plan_item_notify_except(v_id, 'bank_idea_added', true, jsonb_build_object('title', btrim(p_title)), NULL);
  PERFORM public.audit_log_write(p_action=>'bank_idea_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'plan_item', p_entity_id=>v_id::text);
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public.plan_item_to_bank(p_item_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_plan uuid; v_kind text; v_linked uuid; v_title text; v_date date; v_aud text; v_item_title text;
BEGIN
  SELECT workspace_id, plan_id, kind, linked_post_id, target_date, title INTO v_ws, v_plan, v_kind, v_linked, v_date, v_item_title
    FROM public.plan_items WHERE id = p_item_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL OR v_kind <> 'concept' OR v_plan IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF v_linked IS NOT NULL AND EXISTS (SELECT 1 FROM public.posts WHERE id = v_linked AND stage = 'approved')
    THEN RAISE EXCEPTION 'post_approved'; END IF;
  SELECT title, audience INTO v_title, v_aud FROM public.plans WHERE id = v_plan;
  PERFORM public._plan_item_notify_except(p_item_id, 'bank_idea_moved', v_aud <> 'client',
    jsonb_build_object('title', v_item_title, 'from_plan_id', v_plan, 'from_plan_title', v_title, 'target_date', v_date), NULL);
  UPDATE public.plan_items SET plan_id = NULL, target_date = NULL, came_from_plan_title = v_title,
    last_active_at = now(), updated_at = now() WHERE id = p_item_id;
  DELETE FROM public.plan_item_reviews WHERE item_id = p_item_id;
  PERFORM public.audit_log_write(p_action=>'plan_item_to_bank', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('from_plan_id', v_plan, 'target_date', v_date));
END $function$;

CREATE OR REPLACE FUNCTION public.plan_item_from_bank(p_item_id uuid, p_plan_id uuid, p_target_date date, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_pws uuid; v_pos int; v_tz text; v_ptitle text; v_item_title text;
BEGIN
  SELECT workspace_id, title INTO v_ws, v_item_title FROM public.plan_items
    WHERE id = p_item_id AND deleted_at IS NULL AND plan_id IS NULL FOR UPDATE;
  SELECT workspace_id, title INTO v_pws, v_ptitle FROM public.plans WHERE id = p_plan_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL OR v_pws IS NULL OR v_ws <> v_pws THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  SELECT timezone INTO v_tz FROM public.workspaces WHERE id = v_ws;
  IF p_target_date < (now() AT TIME ZONE coalesce(v_tz, 'UTC'))::date THEN RAISE EXCEPTION 'past_date'; END IF;
  SELECT coalesce(max(position), -1) + 1 INTO v_pos FROM public.plan_items WHERE plan_id = p_plan_id AND deleted_at IS NULL;
  UPDATE public.plan_items SET plan_id = p_plan_id, target_date = p_target_date, position = v_pos,
    archived_at = NULL, show_to_client = false, last_active_at = now(), updated_at = now() WHERE id = p_item_id;
  PERFORM public._plan_item_notify_except(p_item_id, 'bank_idea_planned', true,
    jsonb_build_object('title', v_item_title, 'plan_title', v_ptitle, 'target_date', p_target_date), NULL);
  PERFORM public._plan_notify(p_plan_id, 'plan_updated', jsonb_build_object('kind', 'slot_added', 'item_id', p_item_id));
  PERFORM public.audit_log_write(p_action=>'plan_item_from_bank', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('plan_id', p_plan_id, 'target_date', p_target_date));
END $function$;

CREATE OR REPLACE FUNCTION public.bank_idea_set(p_item_id uuid, p_show_to_client boolean, p_archived boolean, p_starred boolean, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_was boolean; v_title text;
BEGIN
  SELECT workspace_id, show_to_client, title INTO v_ws, v_was, v_title FROM public.plan_items
    WHERE id = p_item_id AND deleted_at IS NULL AND plan_id IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_agency_side_member(v_ws) THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  UPDATE public.plan_items SET
    show_to_client = coalesce(p_show_to_client, show_to_client),
    archived_at = CASE WHEN p_archived IS NULL THEN archived_at WHEN p_archived THEN coalesce(archived_at, now()) ELSE NULL END,
    starred_at  = CASE WHEN p_starred IS NULL THEN starred_at WHEN p_starred THEN coalesce(starred_at, now()) ELSE NULL END,
    updated_at = now()
  WHERE id = p_item_id;
  IF p_show_to_client IS TRUE AND v_was IS FALSE THEN
    PERFORM public._plan_item_notify_except(p_item_id, 'bank_idea_shown', false, jsonb_build_object('title', v_title), NULL);
  ELSIF p_show_to_client IS FALSE AND v_was IS TRUE THEN
    PERFORM public._plan_item_notify_except(p_item_id, 'bank_idea_hidden', true, jsonb_build_object('title', v_title), NULL);
  END IF;
  PERFORM public.audit_log_write(p_action=>'bank_idea_set', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('show_to_client', p_show_to_client, 'archived', p_archived, 'starred', p_starred));
END $function$;

-- Applied out of band 6 Nov 2026; the seven bank procs were revoked in 20261106010000_plan_bank.sql without a grant back, so every bank write returned 403 until this
GRANT EXECUTE ON FUNCTION public.bank_idea_create(uuid, text, text, uuid[], uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_item_to_bank(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_item_from_bank(uuid, uuid, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_idea_set(uuid, boolean, boolean, boolean, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_item_buckets_set(uuid, uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_bucket_rename(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_bucket_delete(uuid, uuid) TO authenticated;
