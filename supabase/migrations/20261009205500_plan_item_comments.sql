-- Applied out of band 9 Oct 2026 (step 3b plan comments). No-op on movnexawfhsyuluspxoc.
--
-- plan_item_comments (one thread per plan item; visibility 'everyone' or
-- 'team'; SELECT-only RLS, every write through plan_item_comment_create);
-- inbox_entries gains event types plan_comment / plan_review and entity type
-- plan_item; _plan_item_notify (internal) writes the inbox rows for a plan item
-- (scope 'posts', scope_key = plan id); plan_item_review now calls it when the
-- status is not 'waiting'. All three functions are copied verbatim from live.

-- ---------------------------------------------------------------------------
-- 1. plan_item_comments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plan_item_comments (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  author_user_id uuid,
  body text NOT NULL,
  visibility text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  edited_at timestamp with time zone,
  deleted_at timestamp with time zone,
  CONSTRAINT plan_item_comments_pkey PRIMARY KEY (id),
  CONSTRAINT plan_item_comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT plan_item_comments_body_check CHECK (((char_length(btrim(body)) >= 1) AND (char_length(btrim(body)) <= 5000))),
  CONSTRAINT plan_item_comments_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.plan_items(id) ON DELETE CASCADE,
  CONSTRAINT plan_item_comments_visibility_check CHECK ((visibility = ANY (ARRAY['everyone'::text, 'team'::text]))),
  CONSTRAINT plan_item_comments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS plan_item_comments_author_idx ON public.plan_item_comments USING btree (author_user_id) WHERE (author_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS plan_item_comments_item_idx ON public.plan_item_comments USING btree (item_id, created_at) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS plan_item_comments_workspace_idx ON public.plan_item_comments USING btree (workspace_id);

ALTER TABLE public.plan_item_comments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'plan_item_comments' AND policyname = 'plan_item_comments_select_member'
  ) THEN
    CREATE POLICY plan_item_comments_select_member ON public.plan_item_comments AS PERMISSIVE FOR SELECT TO authenticated
      USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM plan_items i
  WHERE (i.id = plan_item_comments.item_id))) AND ((visibility = 'everyone'::text) OR is_agency_side_member(workspace_id))));
  END IF;
END $$;

-- Table privileges mirror live: authenticated SELECT only; anon none;
-- service_role keeps only the REFERENCES/TRIGGER/TRUNCATE/MAINTAIN defaults.
REVOKE ALL ON public.plan_item_comments FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.plan_item_comments FROM service_role;
REVOKE ALL ON public.plan_item_comments FROM authenticated;
GRANT SELECT ON public.plan_item_comments TO authenticated;
-- srtdio_readonly exists only on the hosted project; guard the grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srtdio_readonly') THEN
    GRANT SELECT ON public.plan_item_comments TO srtdio_readonly;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Inbox event and entity types (the parent constraint; partitions inherit)
-- ---------------------------------------------------------------------------

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK ((event_type = ANY (ARRAY['comment'::text, 'mention'::text, 'stage_change'::text, 'comment_resolved'::text, 'brief_created'::text, 'brief_closed'::text, 'asset_uploaded'::text, 'asset_version_added'::text, 'invite'::text, 'trial_warning'::text, 'billing_failure'::text, 'system'::text, 'checkpoints_added'::text, 'post_ready'::text, 'checkpoint_reopened'::text, 'checkpoint_asked'::text, 'scheduled_sent'::text, 'scheduled_failed'::text, 'reminder'::text, 'post_deleted'::text, 'assets_deleted'::text, 'plan_comment'::text, 'plan_review'::text])));

ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_entity_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_entity_type_check
  CHECK (((entity_type IS NULL) OR (entity_type = ANY (ARRAY['post'::text, 'brief'::text, 'chat_channel'::text, 'workspace'::text, 'plan_item'::text]))));

-- ---------------------------------------------------------------------------
-- 3. Functions (verbatim from live)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._plan_item_notify(p_item_id uuid, p_event_type text, p_team_only boolean, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_plan uuid;
begin
  select i.workspace_id, p.audience, p.id into v_ws, v_aud, v_plan
    from public.plan_items i join public.plans p on p.id = i.plan_id where i.id = p_item_id;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, p_event_type, 'plan_item', p_item_id::text, 'posts', v_plan::text, 'active',
         p_payload || jsonb_build_object('plan_id', v_plan), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id <> auth.uid()
     and (wm.role = any (array['owner','admin','agency'])
          or (not p_team_only and v_aud = 'client' and wm.role = 'client'));
end $function$;

CREATE OR REPLACE FUNCTION public.plan_item_comment_create(p_item_id uuid, p_body text, p_visibility text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_agency boolean; v_id uuid;
begin
  select i.workspace_id, p.audience into v_ws, v_aud
    from public.plan_items i join public.plans p on p.id = i.plan_id
   where i.id = p_item_id and i.deleted_at is null and p.deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  if p_visibility not in ('everyone','team') then raise exception 'invalid_payload'; end if;
  v_agency := public.is_agency_side_member(v_ws);
  if not v_agency then
    if v_aud <> 'client' then raise exception 'forbidden_role'; end if;
    if p_visibility <> 'everyone' then raise exception 'forbidden_role'; end if;
  end if;
  begin
    insert into public.plan_item_comments (workspace_id, item_id, author_user_id, body, visibility)
    values (v_ws, p_item_id, auth.uid(), btrim(p_body), p_visibility) returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public._plan_item_notify(p_item_id, 'plan_comment', p_visibility = 'team',
    jsonb_build_object('comment_id', v_id, 'visibility', p_visibility));
  perform public.audit_log_write(p_action=>'plan_item_comment_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('comment_id', v_id, 'visibility', p_visibility));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.plan_item_review(p_item_id uuid, p_side text, p_status text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text; v_aud text;
begin
  select i.workspace_id, i.kind, p.audience into v_ws, v_kind, v_aud
    from public.plan_items i join public.plans p on p.id = i.plan_id
   where i.id = p_item_id and i.deleted_at is null and p.deleted_at is null
   for update of i;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if p_side not in ('team','client') or p_status not in ('waiting','approved','changes') then raise exception 'invalid_payload'; end if;
  if p_side = 'team' then
    if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  else
    if not exists (select 1 from public.workspace_members wm
                    where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true and wm.role = 'client') then
      raise exception 'forbidden_role'; end if;
    if v_aud <> 'client' then raise exception 'forbidden_role'; end if;
    if v_kind = 'post' then raise exception 'use_stage_transition'; end if;
  end if;
  insert into public.plan_item_reviews (item_id, workspace_id, side, status, reviewed_by, reviewed_at)
  values (p_item_id, v_ws, p_side, p_status, auth.uid(), now())
  on conflict (item_id, side) do update
    set status = excluded.status, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at;
  if p_status <> 'waiting' then
    perform public._plan_item_notify(p_item_id, 'plan_review', p_side = 'team',
      jsonb_build_object('side', p_side, 'status', p_status));
  end if;
  perform public.audit_log_write(p_action=>'plan_item_review', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('side', p_side, 'status', p_status, 'kind', v_kind));
end $function$;

-- Function privileges mirror live: _plan_item_notify is internal (owner only);
-- the two procs are EXECUTE to authenticated only.
REVOKE ALL ON FUNCTION public._plan_item_notify(uuid, text, boolean, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.plan_item_comment_create(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_comment_create(uuid, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_item_review(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_review(uuid, text, text, uuid) TO authenticated;
