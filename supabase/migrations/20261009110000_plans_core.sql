-- Applied out of band 9 Oct 2026 (step 3a plans). No-op on movnexawfhsyuluspxoc.
--
-- Restates live exactly: plans, plan_items and plan_item_reviews (columns,
-- CHECKs, FKs, indexes, RLS, one SELECT policy each, table grants), the
-- 'plan_item' entity type and policy branch on asset_attachments, the
-- is_agency_side_member helper, the internal _plan_* helpers (no EXECUTE for
-- authenticated) and the ten plan procs (SECURITY DEFINER, search_path '',
-- EXECUTE to authenticated). Idempotent on live; clean on an empty database.

-- ---------------------------------------------------------------------------
-- Role helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_agency_side_member(p_workspace_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid() and wm.active = true
       and wm.role = any (array['owner','admin','agency']));
$function$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plans (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  audience text NOT NULL,
  shared_with_client_at timestamptz,
  shared_with_client_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT plans_pkey PRIMARY KEY (id),
  CONSTRAINT plans_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT plans_shared_with_client_by_fkey FOREIGN KEY (shared_with_client_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT plans_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
  CONSTRAINT plans_audience_check CHECK ((audience = ANY (ARRAY['team'::text, 'client'::text]))),
  CONSTRAINT plans_dates CHECK (((ends_on >= starts_on) AND ((ends_on - starts_on) <= 92))),
  CONSTRAINT plans_shared_consistency CHECK ((((audience = 'team'::text) AND (shared_with_client_at IS NULL) AND (shared_with_client_by IS NULL)) OR ((audience = 'client'::text) AND (shared_with_client_at IS NOT NULL))))
);

CREATE TABLE IF NOT EXISTS public.plan_items (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  kind text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  title text,
  description text,
  post_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT plan_items_pkey PRIMARY KEY (id),
  CONSTRAINT plan_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT plan_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE,
  CONSTRAINT plan_items_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT plan_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT plan_items_kind_check CHECK ((kind = ANY (ARRAY['concept'::text, 'post'::text]))),
  CONSTRAINT plan_items_shape CHECK ((((kind = 'concept'::text) AND (post_id IS NULL) AND (title IS NOT NULL) AND ((char_length(title) >= 1) AND (char_length(title) <= 200)) AND ((description IS NULL) OR (char_length(description) <= 5000))) OR ((kind = 'post'::text) AND (post_id IS NOT NULL) AND (title IS NULL) AND (description IS NULL))))
);

CREATE TABLE IF NOT EXISTS public.plan_item_reviews (
  item_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  side text NOT NULL,
  status text NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_item_reviews_pkey PRIMARY KEY (item_id, side),
  CONSTRAINT plan_item_reviews_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.plan_items(id) ON DELETE CASCADE,
  CONSTRAINT plan_item_reviews_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT plan_item_reviews_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT plan_item_reviews_side_check CHECK ((side = ANY (ARRAY['team'::text, 'client'::text]))),
  CONSTRAINT plan_item_reviews_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'approved'::text, 'changes'::text])))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS plan_item_reviews_by_idx ON public.plan_item_reviews USING btree (reviewed_by) WHERE (reviewed_by IS NOT NULL);
CREATE INDEX IF NOT EXISTS plan_item_reviews_workspace_idx ON public.plan_item_reviews USING btree (workspace_id);
CREATE INDEX IF NOT EXISTS plan_items_created_by_idx ON public.plan_items USING btree (created_by) WHERE (created_by IS NOT NULL);
CREATE INDEX IF NOT EXISTS plan_items_plan_idx ON public.plan_items USING btree (plan_id, "position") WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS plan_items_post_idx ON public.plan_items USING btree (post_id) WHERE (post_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS plan_items_post_once ON public.plan_items USING btree (plan_id, post_id) WHERE ((deleted_at IS NULL) AND (kind = 'post'::text));
CREATE INDEX IF NOT EXISTS plan_items_workspace_idx ON public.plan_items USING btree (workspace_id);
CREATE INDEX IF NOT EXISTS plans_created_by_idx ON public.plans USING btree (created_by) WHERE (created_by IS NOT NULL);
CREATE INDEX IF NOT EXISTS plans_shared_by_idx ON public.plans USING btree (shared_with_client_by) WHERE (shared_with_client_by IS NOT NULL);
CREATE INDEX IF NOT EXISTS plans_workspace_idx ON public.plans USING btree (workspace_id, starts_on DESC) WHERE (deleted_at IS NULL);

-- ---------------------------------------------------------------------------
-- RLS and policies (one SELECT policy each; no write policies)
-- ---------------------------------------------------------------------------

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_item_reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'plans' AND policyname = 'plans_select_member'
  ) THEN
    CREATE POLICY plans_select_member ON public.plans AS PERMISSIVE FOR SELECT TO authenticated
      USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = plans.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true) AND ((plans.audience = 'client'::text) OR (wm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'agency'::text]))))))));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'plan_items' AND policyname = 'plan_items_select_member'
  ) THEN
    CREATE POLICY plan_items_select_member ON public.plan_items AS PERMISSIVE FOR SELECT TO authenticated
      USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM plans p
  WHERE (p.id = plan_items.plan_id))) AND ((kind = 'concept'::text) OR (EXISTS ( SELECT 1
   FROM posts po
  WHERE (po.id = plan_items.post_id))))));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'plan_item_reviews' AND policyname = 'plan_item_reviews_select_member'
  ) THEN
    CREATE POLICY plan_item_reviews_select_member ON public.plan_item_reviews AS PERMISSIVE FOR SELECT TO authenticated
      USING (((EXISTS ( SELECT 1
   FROM plan_items i
  WHERE (i.id = plan_item_reviews.item_id))) AND ((side = 'client'::text) OR (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = plan_item_reviews.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'agency'::text]))))))));
  END IF;
END $$;

-- Table privileges mirror live: authenticated SELECT only; anon none;
-- service_role keeps only the REFERENCES/TRIGGER/TRUNCATE/MAINTAIN defaults
-- (every write goes through the SECURITY DEFINER procs below).
REVOKE ALL ON public.plans FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.plans FROM service_role;
REVOKE ALL ON public.plans FROM authenticated;
GRANT SELECT ON public.plans TO authenticated;
REVOKE ALL ON public.plan_items FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.plan_items FROM service_role;
REVOKE ALL ON public.plan_items FROM authenticated;
GRANT SELECT ON public.plan_items TO authenticated;
REVOKE ALL ON public.plan_item_reviews FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.plan_item_reviews FROM service_role;
REVOKE ALL ON public.plan_item_reviews FROM authenticated;
GRANT SELECT ON public.plan_item_reviews TO authenticated;
-- srtdio_readonly exists only on the hosted project; guard the grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srtdio_readonly') THEN
    GRANT SELECT ON public.plans TO srtdio_readonly;
    GRANT SELECT ON public.plan_items TO srtdio_readonly;
    GRANT SELECT ON public.plan_item_reviews TO srtdio_readonly;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- asset_attachments: the 'plan_item' entity type and its policy branch
-- ---------------------------------------------------------------------------

ALTER TABLE public.asset_attachments DROP CONSTRAINT IF EXISTS asset_attachments_entity_type_check;
ALTER TABLE public.asset_attachments ADD CONSTRAINT asset_attachments_entity_type_check CHECK ((entity_type = ANY (ARRAY['post'::text, 'comment'::text, 'chat_message'::text, 'brief'::text, 'plan_item'::text])));

ALTER POLICY asset_attachments_select_member ON public.asset_attachments
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = asset_attachments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))) AND
CASE entity_type
    WHEN 'post'::text THEN (EXISTS ( SELECT 1
       FROM posts p
      WHERE (p.id = (asset_attachments.entity_id)::uuid)))
    WHEN 'brief'::text THEN (EXISTS ( SELECT 1
       FROM briefs b
      WHERE (b.id = (asset_attachments.entity_id)::uuid)))
    WHEN 'comment'::text THEN (EXISTS ( SELECT 1
       FROM comments c
      WHERE (c.id = (asset_attachments.entity_id)::uuid)))
    WHEN 'plan_item'::text THEN (EXISTS ( SELECT 1
       FROM plan_items pi
      WHERE (pi.id = (asset_attachments.entity_id)::uuid)))
    ELSE true
END));

-- ---------------------------------------------------------------------------
-- Internal helpers (no EXECUTE for authenticated)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._plan_check_versions(p_workspace_id uuid, p_version_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_version_ids is null or cardinality(p_version_ids) = 0 then return; end if;
  if cardinality(p_version_ids) > 20 then raise exception 'invalid_payload'; end if;
  if exists (select 1 from unnest(p_version_ids) av(id)
             left join public.asset_versions v on v.id = av.id and v.workspace_id = p_workspace_id
             where v.id is null) then raise exception 'invalid_payload'; end if;
  if exists (select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
             where v.id = any (p_version_ids) and (a.origin = 'chat' or a.deleted_at is not null)) then
    raise exception 'attachment not available'; end if;
end $function$;

CREATE OR REPLACE FUNCTION public._plan_attach_versions(p_workspace_id uuid, p_item_id uuid, p_version_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i int;
begin
  if p_version_ids is null or cardinality(p_version_ids) = 0 then return; end if;
  for i in 1..cardinality(p_version_ids) loop
    insert into public.asset_attachments (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
    select v.asset_id, v.id, 'plan_item', p_item_id::text, p_workspace_id, i - 1, auth.uid()
      from public.asset_versions v where v.id = p_version_ids[i];
  end loop;
end $function$;

-- ---------------------------------------------------------------------------
-- Procs (SECURITY DEFINER, search_path '', EXECUTE to authenticated)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.plan_create(p_workspace_id uuid, p_title text, p_starts_on date, p_ends_on date, p_audience text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid;
begin
  if not public.is_active_workspace_member(p_workspace_id) then raise exception 'workspace_member_only'; end if;
  if not public.is_agency_side_member(p_workspace_id) then raise exception 'forbidden_role'; end if;
  begin
    insert into public.plans (workspace_id, title, starts_on, ends_on, audience,
                              shared_with_client_at, shared_with_client_by, created_by)
    values (p_workspace_id, btrim(p_title), p_starts_on, p_ends_on, p_audience,
            case when p_audience = 'client' then now() end,
            case when p_audience = 'client' then auth.uid() end, auth.uid())
    returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public.audit_log_write(p_action=>'plan_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'plan', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('audience', p_audience, 'starts_on', p_starts_on, 'ends_on', p_ends_on));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.plan_update(p_plan_id uuid, p_title text, p_starts_on date, p_ends_on date, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  begin
    update public.plans set title = btrim(p_title), starts_on = p_starts_on, ends_on = p_ends_on, updated_at = now()
     where id = p_plan_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public.audit_log_write(p_action=>'plan_update', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text,
    p_payload=>jsonb_build_object('starts_on', p_starts_on, 'ends_on', p_ends_on));
end $function$;

CREATE OR REPLACE FUNCTION public.plan_share_with_client(p_plan_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text;
begin
  select workspace_id, audience into v_ws, v_aud from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if v_aud = 'client' then return; end if;
  if exists (select 1 from public.plan_items i join public.posts p on p.id = i.post_id
              where i.plan_id = p_plan_id and i.deleted_at is null and i.kind = 'post'
                and p.deleted_at is null and p.stage = 'draft') then
    raise exception 'plan_has_drafts'; end if;
  update public.plans set audience = 'client', shared_with_client_at = now(), shared_with_client_by = auth.uid(),
                          updated_at = now()
   where id = p_plan_id;
  perform public.audit_log_write(p_action=>'plan_share_with_client', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text, p_payload=>'{}'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.plan_delete(p_plan_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  update public.plans set deleted_at = now(), updated_at = now() where id = p_plan_id;
  perform public.audit_log_write(p_action=>'plan_delete', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text, p_payload=>'{}'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.plan_concept_add(p_plan_id uuid, p_title text, p_description text, p_attachment_version_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_id uuid; v_pos int;
begin
  select workspace_id into v_ws from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  perform public._plan_check_versions(v_ws, p_attachment_version_ids);
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  begin
    insert into public.plan_items (workspace_id, plan_id, kind, position, title, description, created_by)
    values (v_ws, p_plan_id, 'concept', v_pos, btrim(p_title), nullif(btrim(p_description), ''), auth.uid())
    returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'invalid_payload';
  end;
  perform public._plan_attach_versions(v_ws, v_id, p_attachment_version_ids);
  perform public.audit_log_write(p_action=>'plan_concept_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('plan_id', p_plan_id, 'attachments', coalesce(cardinality(p_attachment_version_ids), 0)));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.plan_concept_edit(p_item_id uuid, p_title text, p_description text, p_attachment_version_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text;
begin
  select workspace_id, kind into v_ws, v_kind from public.plan_items where id = p_item_id and deleted_at is null for update;
  if v_ws is null or v_kind <> 'concept' then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  begin
    update public.plan_items set title = btrim(p_title), description = nullif(btrim(p_description), ''), updated_at = now()
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
    p_payload=>jsonb_build_object('files_changed', p_attachment_version_ids is not null));
end $function$;

CREATE OR REPLACE FUNCTION public.plan_posts_add(p_plan_id uuid, p_post_ids uuid[], p_trace_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_aud text; v_pos int; v_added int;
begin
  select workspace_id, audience into v_ws, v_aud from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_post_ids is null or cardinality(p_post_ids) not between 1 and 50 then raise exception 'invalid_payload'; end if;
  if exists (select 1 from unnest(p_post_ids) x(id)
             left join public.posts p on p.id = x.id and p.workspace_id = v_ws and p.deleted_at is null
             where p.id is null) then raise exception 'invalid_payload'; end if;
  if v_aud = 'client' and exists (select 1 from public.posts where id = any (p_post_ids) and stage = 'draft') then
    raise exception 'plan_has_drafts'; end if;
  select coalesce(max(position), -1) + 1 into v_pos from public.plan_items where plan_id = p_plan_id and deleted_at is null;
  insert into public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by)
  select v_ws, p_plan_id, 'post', v_pos + x.ord - 1, x.id, auth.uid()
    from (select distinct on (id) id, ord from unnest(p_post_ids) with ordinality u(id, ord) order by id, ord) x
   where not exists (select 1 from public.plan_items i
                      where i.plan_id = p_plan_id and i.post_id = x.id and i.deleted_at is null);
  get diagnostics v_added = row_count;
  perform public.audit_log_write(p_action=>'plan_posts_add', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text,
    p_payload=>jsonb_build_object('added', v_added));
  return v_added;
end $function$;

CREATE OR REPLACE FUNCTION public.plan_item_remove(p_item_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_plan uuid;
begin
  select workspace_id, plan_id into v_ws, v_plan from public.plan_items where id = p_item_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  update public.plan_items set deleted_at = now(), updated_at = now() where id = p_item_id;
  perform public.audit_log_write(p_action=>'plan_item_remove', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('plan_id', v_plan));
end $function$;

CREATE OR REPLACE FUNCTION public.plan_items_reorder(p_plan_id uuid, p_item_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.plans where id = p_plan_id and deleted_at is null for update;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_item_ids is null
     or cardinality(p_item_ids) <> (select count(*) from public.plan_items where plan_id = p_plan_id and deleted_at is null)
     or cardinality(p_item_ids) <> (select count(distinct x) from unnest(p_item_ids) x)
     or exists (select 1 from unnest(p_item_ids) x(id)
                 where not exists (select 1 from public.plan_items i
                                    where i.id = x.id and i.plan_id = p_plan_id and i.deleted_at is null)) then
    raise exception 'invalid_payload'; end if;
  update public.plan_items i set position = u.ord - 1, updated_at = now()
    from unnest(p_item_ids) with ordinality u(id, ord) where i.id = u.id;
  perform public.audit_log_write(p_action=>'plan_items_reorder', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan', p_entity_id=>p_plan_id::text, p_payload=>'{}'::jsonb);
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
  perform public.audit_log_write(p_action=>'plan_item_review', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'plan_item', p_entity_id=>p_item_id::text,
    p_payload=>jsonb_build_object('side', p_side, 'status', p_status, 'kind', v_kind));
end $function$;

-- ---------------------------------------------------------------------------
-- Function privileges mirror live: EXECUTE to authenticated on the helper and
-- the procs; the _plan_* helpers are owner-only.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.is_agency_side_member(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_agency_side_member(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public._plan_check_versions(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._plan_attach_versions(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.plan_create(uuid, text, date, date, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_create(uuid, text, date, date, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_update(uuid, text, date, date, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_update(uuid, text, date, date, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_share_with_client(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_share_with_client(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_delete(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_delete(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_concept_add(uuid, text, text, uuid[], uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_concept_edit(uuid, text, text, uuid[], uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_posts_add(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_posts_add(uuid, uuid[], uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_item_remove(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_remove(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_items_reorder(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_items_reorder(uuid, uuid[], uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_item_review(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_item_review(uuid, text, text, uuid) TO authenticated;
