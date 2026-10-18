-- Record of a schema change ALREADY APPLIED LIVE on movnexawfhsyuluspxoc (18 Oct 2026, via MCP).
-- Activity: brief activity reaches every member, the person who acted gets their own row
-- (already read), brief_closed and brief_post_created are written, and a one-time 7-day backfill.
-- Additive only: no existing inbox row is deleted, rewritten or re-sorted.
-- Proc changes are applied as anchored text patches on the current definitions (each patch
-- raises if its anchor is missing), identical to what ran live. Backfill is guarded by
-- NOT EXISTS, so it inserts nothing on a fresh database or a re-run.


-- 1. New event type: post created from a brief (widens the CHECK; no data touched)
alter table public.inbox_entries drop constraint if exists inbox_entries_event_type_check;
alter table public.inbox_entries add constraint inbox_entries_event_type_check check (event_type = any (array[
 'comment','mention','stage_change','comment_resolved','brief_created','brief_closed','asset_uploaded','asset_version_added',
 'invite','trial_warning','billing_failure','system','checkpoints_added','post_ready','checkpoint_reopened','checkpoint_asked',
 'scheduled_sent','scheduled_failed','reminder','post_deleted','assets_deleted','plan_comment','plan_review','plan_opened',
 'plan_deleted','plan_date_changed','plan_updated','task_changed','task_due','brief_post_created']));

-- 2. Helper: one already-read row for the person who acted. Not callable by app users.
create or replace function public.inbox_self_entry(p_workspace_id uuid, p_event_type text, p_entity_type text,
  p_entity_id text, p_scope text, p_scope_key text, p_payload jsonb)
returns void language plpgsql security definer set search_path to '' as $f$
begin
  if auth.uid() is null then return; end if;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key,
                                    tier, payload, actor_user_id, read_at)
  values (auth.uid(), p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_scope, p_scope_key,
          'active', p_payload, auth.uid(), now());
end $f$;
revoke execute on function public.inbox_self_entry(uuid,text,text,text,text,text,jsonb) from public, anon, authenticated, service_role;

-- 3. Patch helper (session-only). Fails loudly if an anchor is missing.
create function pg_temp.patch(p_fn regprocedure, p_old text, p_new text) returns void language plpgsql as $f$
declare d text;
begin
  d := pg_get_functiondef(p_fn);
  if position(p_old in d) = 0 then raise exception 'anchor missing in %', p_fn; end if;
  execute replace(d, p_old, p_new);
end $f$;

-- 3a. stage_transition: own row
select pg_temp.patch('public.stage_transition(uuid,text,uuid,uuid)',
$o$  return p_post_id;
end; $function$$o$,
$n$  perform public.inbox_self_entry(v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text,
    jsonb_build_object('from', v_from, 'to', p_to_stage, 'actor_role', v_role, 'on_behalf_of', p_on_behalf_of));
  return p_post_id;
end; $function$$n$);

-- 3b. post_soft_delete: own row
select pg_temp.patch('public.post_soft_delete(uuid,uuid)',
$o$  return p_post_id;
end; $function$$o$,
$n$  perform public.inbox_self_entry(v_ws, 'post_deleted', 'post', p_post_id::text, 'posts', p_post_id::text,
    (select jsonb_build_object('number', p.number, 'title', left(coalesce(p.title, p.caption, ''), 120), 'actor_role', v_role)
       from public.posts p where p.id = p_post_id));
  return p_post_id;
end; $function$$n$);

-- 3c. comment_create: clients get brief comments/mentions; own row
select pg_temp.patch('public.comment_create(uuid,text,uuid,uuid,text,jsonb,uuid[],uuid)',
$o$OR (p_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner))$o$,
$n$OR (p_entity_type='brief')$n$);
select pg_temp.patch('public.comment_create(uuid,text,uuid,uuid,text,jsonb,uuid[],uuid)',
$o$  PERFORM public.audit_log_write('comment_create'$o$,
$n$  PERFORM public.inbox_self_entry(p_workspace_id, 'comment', p_entity_type, p_entity_id::text, v_scope,
    p_entity_id::text, jsonb_build_object('comment_id', v_id));
  PERFORM public.audit_log_write('comment_create'$n$);

-- 3d. comment_batch_create: own row
select pg_temp.patch('public.comment_batch_create(uuid,uuid,jsonb,uuid)',
$o$  PERFORM public.audit_log_write('comment_batch_create'$o$,
$n$  PERFORM public.inbox_self_entry(p_workspace_id, 'checkpoints_added', 'post', p_post_id::text, 'posts',
    p_post_id::text, jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs)));
  PERFORM public.audit_log_write('comment_batch_create'$n$);

-- 3e. comment_resolve: brief gate opened to all brief comment authors; own row on resolve
select pg_temp.patch('public.comment_resolve(uuid,boolean,uuid,text)',
$o$OR (v_entity_type = 'brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner))$o$,
$n$OR (v_entity_type = 'brief')$n$);
select pg_temp.patch('public.comment_resolve(uuid,boolean,uuid,text)',
$o$  PERFORM public.audit_log_write('comment_resolve'$o$,
$n$  IF p_resolved AND v_rows > 0 THEN
    PERFORM public.inbox_self_entry(v_ws, 'comment_resolved', v_entity_type, v_entity_id::text, v_scope,
      v_entity_id::text, jsonb_build_object('comment_id', p_comment_id));
  END IF;
  PERFORM public.audit_log_write('comment_resolve'$n$);

-- 3f. brief_create: clients included; own row
select pg_temp.patch('public.brief_create(uuid,jsonb,uuid)',
$o$     AND m.role IN ('owner','admin','agency') AND m.user_id <> v_uid;$o$,
$n$     AND m.user_id <> v_uid;
  PERFORM public.inbox_self_entry(p_workspace_id, 'brief_created', 'brief', v_id::text, 'briefs', NULL,
    jsonb_build_object('title', v_title, 'number', v_number));$n$);

-- 3g. asset_delete / asset_delete_many: own row
select pg_temp.patch('public.asset_delete(uuid,uuid)',
$o$   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
END; $function$$o$,
$n$   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  PERFORM public.inbox_self_entry(v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text,
    jsonb_build_object('count', 1, 'filenames', jsonb_build_array(v_name), 'actor_role', v_role));
END; $function$$n$);
select pg_temp.patch('public.asset_delete_many(uuid[],uuid)',
$o$   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
END; $function$$o$,
$n$   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
  PERFORM public.inbox_self_entry(v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text,
    jsonb_build_object('count', cardinality(v_ids), 'filenames', to_jsonb(v_names), 'actor_role', v_role));
END; $function$$n$);

-- 3h. checkpoint_ask / checkpoint_send_back / post_ready_notify: own row
select pg_temp.patch('public.checkpoint_ask(uuid,text,uuid)',
$o$  PERFORM public.audit_log_write('checkpoint_ask'$o$,
$n$  PERFORM public.inbox_self_entry(v_ws, 'checkpoint_asked', 'post', v_entity_id::text, 'posts', v_entity_id::text,
    jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq, 'reply_id', v_reply));
  PERFORM public.audit_log_write('checkpoint_ask'$n$);
select pg_temp.patch('public.checkpoint_send_back(uuid,text,uuid)',
$o$  PERFORM public.audit_log_write('checkpoint_send_back'$o$,
$n$  PERFORM public.inbox_self_entry(v_ws, 'checkpoint_reopened', 'post', v_entity_id::text, 'posts', v_entity_id::text,
    jsonb_build_object('comment_id', p_comment_id, 'seq', v_seq, 'reply_id', v_reply));
  PERFORM public.audit_log_write('checkpoint_send_back'$n$);
select pg_temp.patch('public.post_ready_notify(uuid,uuid)',
$o$  PERFORM public.audit_log_write('post_ready_notify'$o$,
$n$  PERFORM public.inbox_self_entry(v_ws, 'post_ready', 'post', p_post_id::text, 'posts', p_post_id::text,
    jsonb_build_object('checkpoints', v_total));
  PERFORM public.audit_log_write('post_ready_notify'$n$);

-- 4. brief_close: everyone in the workspace gets "<name> closed <brief>"; own row
create or replace function public.brief_close(p_brief_id uuid, p_trace_id uuid)
 returns void language plpgsql security definer set search_path to '' as $f$
DECLARE v_ws uuid; v_creator uuid; v_status text; v_title text; v_number integer; v_role text; v_uid uuid := auth.uid();
BEGIN
  SELECT workspace_id, created_by, status, title, number INTO v_ws, v_creator, v_status, v_title, v_number
    FROM public.briefs WHERE id = p_brief_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT (public.proc_capability(v_ws,'brief.close')
          OR (public.proc_capability(v_ws,'brief.close_own') AND v_creator = v_uid)) THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = v_uid AND wm.active = true;
  UPDATE public.briefs SET status = 'closed', closed_at = now(), closed_by = v_uid, row_version = row_version + 1
    WHERE id = p_brief_id;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id,
                                    scope, scope_key, tier, payload, actor_user_id)
  SELECT m.user_id, v_ws, 'brief_closed', 'brief', p_brief_id::text, 'briefs', NULL, 'active',
         jsonb_build_object('title', v_title, 'number', v_number, 'actor_role', v_role), v_uid
    FROM public.workspace_members m
   WHERE m.workspace_id = v_ws AND m.active AND m.user_id <> v_uid;
  PERFORM public.inbox_self_entry(v_ws, 'brief_closed', 'brief', p_brief_id::text, 'briefs', NULL,
    jsonb_build_object('title', v_title, 'number', v_number, 'actor_role', v_role));
  PERFORM public.audit_log_write('brief_close','success',p_trace_id,v_ws,'brief',p_brief_id::text,NULL);
END; $f$;

-- 5. post_create: "<name> created <post> from brief <brief>" (respects draft visibility); own row
select pg_temp.patch('public.post_create(uuid,jsonb,uuid)',
$o$  RETURN v_id;
END; $function$$o$,
$n$  IF v_brief IS NOT NULL THEN
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id,
                                      scope, scope_key, tier, payload, actor_user_id)
    SELECT wm.user_id, p_workspace_id, 'brief_post_created', 'post', v_id::text, 'briefs', v_brief::text, 'active',
           jsonb_build_object('post_title', v_title, 'post_number', v_number, 'brief_id', v_brief,
                              'brief_title', b.title, 'brief_number', b.number), auth.uid()
      FROM public.workspace_members wm JOIN public.briefs b ON b.id = v_brief
     WHERE wm.workspace_id = p_workspace_id AND wm.active = true AND wm.user_id <> auth.uid()
       AND (wm.role IN ('owner','admin','agency')
            OR EXISTS (SELECT 1 FROM public.workspace_role_permissions r
                        WHERE r.workspace_id = p_workspace_id AND r.role = wm.role
                          AND r.capability = 'pipeline.view_all_stages' AND r.allowed = true));
    PERFORM public.inbox_self_entry(p_workspace_id, 'brief_post_created', 'post', v_id::text, 'briefs', v_brief::text,
      (SELECT jsonb_build_object('post_title', v_title, 'post_number', v_number, 'brief_id', v_brief,
                                 'brief_title', b.title, 'brief_number', b.number)
         FROM public.briefs b WHERE b.id = v_brief));
  END IF;
  RETURN v_id;
END; $function$$n$);

-- 6. Backfill, last 7 days only, every row arrives already read. Only members who had joined by then.
-- 6a. Brief closes (everyone incl. the closer)
insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key,
                                  tier, payload, actor_user_id, read_at, created_at)
select wm.user_id, b.workspace_id, 'brief_closed', 'brief', b.id::text, 'briefs', null, 'active',
       jsonb_build_object('title', b.title, 'number', b.number), b.closed_by, now(), b.closed_at
  from public.briefs b
  join public.workspace_members wm on wm.workspace_id = b.workspace_id and wm.active
   and coalesce(wm.rejoined_at, wm.accepted_at) <= b.closed_at
 where b.closed_at >= now() - interval '7 days' and b.deleted_at is null
   and not exists (select 1 from public.inbox_entries i
                    where i.event_type = 'brief_closed' and i.entity_id = b.id::text and i.user_id = wm.user_id);

-- 6b. Posts created from a brief
insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key,
                                  tier, payload, actor_user_id, read_at, created_at)
select wm.user_id, p.workspace_id, 'brief_post_created', 'post', p.id::text, 'briefs', p.brief_id::text, 'active',
       jsonb_build_object('post_title', p.title, 'post_number', p.number, 'brief_id', p.brief_id,
                          'brief_title', b.title, 'brief_number', b.number), p.created_by, now(), p.created_at
  from public.posts p
  join public.briefs b on b.id = p.brief_id
  join public.workspace_members wm on wm.workspace_id = p.workspace_id and wm.active
   and coalesce(wm.rejoined_at, wm.accepted_at) <= p.created_at
 where p.brief_id is not null and p.deleted_at is null and p.created_at >= now() - interval '7 days'
   and (wm.user_id = p.created_by or wm.role in ('owner','admin','agency')
        or exists (select 1 from public.workspace_role_permissions r where r.workspace_id = p.workspace_id
                    and r.role = wm.role and r.capability = 'pipeline.view_all_stages' and r.allowed = true))
   and not exists (select 1 from public.inbox_entries i
                    where i.event_type = 'brief_post_created' and i.entity_id = p.id::text and i.user_id = wm.user_id);

-- 6c. Your own actions (copied from the row others received)
insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key,
                                  tier, payload, actor_user_id, read_at, created_at)
select distinct on (i.workspace_id, i.event_type, i.entity_id, i.actor_user_id, i.created_at)
       i.actor_user_id, i.workspace_id, i.event_type, i.entity_type, i.entity_id, i.scope, i.scope_key, 'active',
       i.payload, i.actor_user_id, now(), i.created_at
  from public.inbox_entries i
  join public.workspace_members wm on wm.workspace_id = i.workspace_id and wm.user_id = i.actor_user_id and wm.active
 where i.created_at >= now() - interval '7 days' and i.deleted_at is null
   and i.actor_user_id is not null and i.actor_user_id <> i.user_id
   and i.event_type in ('stage_change','post_deleted','comment','comment_resolved','checkpoints_added',
                        'checkpoint_asked','checkpoint_reopened','post_ready','brief_created','assets_deleted')
   and not exists (select 1 from public.inbox_entries s
                    where s.user_id = i.actor_user_id and s.workspace_id = i.workspace_id
                      and s.event_type = i.event_type and s.entity_id is not distinct from i.entity_id
                      and s.created_at = i.created_at)
 order by i.workspace_id, i.event_type, i.entity_id, i.actor_user_id, i.created_at;

