-- Record only: already applied live via MCP (project movnexawfhsyuluspxoc). Do not execute.
-- A plan concept can point at one existing post (the post made for it).
--  a) plan_items.linked_post_id: concepts only, ON DELETE SET NULL (a post's
--     hard delete never deletes the concept), one concept per post per plan.
--  b) plan_concept_link_post: agency side only; linking needs an approved
--     review on the concept and a live post in the same workspace; null unlinks;
--     the same value is a no-op. Writes audit_log only: no reviews, comments,
--     post stage or notifications are touched.
--  c) plan_bundle_read: items carry linked_post_id; linked posts join the posts
--     and thumbs lookups; each posts entry carries 'deleted'.
-- Function bodies are pg_get_functiondef output from the live project.

ALTER TABLE public.plan_items
  ADD COLUMN linked_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL;
ALTER TABLE public.plan_items
  ADD CONSTRAINT plan_items_linked_post_concept_only CHECK (((kind = 'concept'::text) OR (linked_post_id IS NULL)));
CREATE UNIQUE INDEX plan_items_linked_post_once ON public.plan_items USING btree (plan_id, linked_post_id) WHERE ((deleted_at IS NULL) AND (linked_post_id IS NOT NULL));
CREATE INDEX plan_items_linked_post_idx ON public.plan_items USING btree (linked_post_id) WHERE (linked_post_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.plan_concept_link_post(p_item_id uuid, p_post_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ws uuid; v_kind text; v_old uuid;
begin
  select i.workspace_id, i.kind, i.linked_post_id into v_ws, v_kind, v_old
    from public.plan_items i join public.plans pl on pl.id = i.plan_id and pl.deleted_at is null
   where i.id = p_item_id and i.deleted_at is null for update of i;
  if v_ws is null or v_kind <> 'concept' then raise exception 'invalid_payload'; end if;
  if not public.is_agency_side_member(v_ws) then raise exception 'forbidden_role'; end if;
  if p_post_id is not null then
    if not exists (select 1 from public.plan_item_reviews r
                    where r.item_id = p_item_id and r.status = 'approved')
      then raise exception 'concept_not_approved'; end if;
    if not exists (select 1 from public.posts p
                    where p.id = p_post_id and p.workspace_id = v_ws and p.deleted_at is null)
      then raise exception 'invalid_payload'; end if;
  end if;
  if v_old is not distinct from p_post_id then return; end if;
  begin
    update public.plan_items set linked_post_id = p_post_id, updated_at = now() where id = p_item_id;
  exception when unique_violation then raise exception 'post_already_linked';
  end;
  perform public.audit_log_write(p_action=>'plan_concept_link_post', p_outcome=>'success',
    p_trace_id=>p_trace_id, p_workspace_id=>v_ws, p_entity_type=>'plan_item',
    p_entity_id=>p_item_id::text, p_payload=>jsonb_build_object('from', v_old, 'to', p_post_id));
end $function$
;
REVOKE ALL ON FUNCTION public.plan_concept_link_post(p_item_id uuid, p_post_id uuid, p_trace_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.plan_concept_link_post(p_item_id uuid, p_post_id uuid, p_trace_id uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.plan_bundle_read(p_trace_id uuid, p_workspace_id uuid, p_plan_ids uuid[] DEFAULT NULL::uuid[], p_range_start date DEFAULT NULL::date, p_range_end date DEFAULT NULL::date, p_only_shared boolean DEFAULT false, p_channel_id text DEFAULT NULL::text, p_before_starts_on date DEFAULT NULL::date, p_before_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  c_ts constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  c_page constant int := 12;
  v_tz text; v_plans jsonb; v_ids uuid[]; v_created timestamptz; v_more boolean := false; v_next jsonb;
  v_items jsonb; v_item_ids uuid[]; v_post_ids uuid[]; v_concept_ids uuid[];
  v_drafts jsonb := '[]'; v_chunk int; v_loose jsonb := '[]'; v_loose_ids uuid[] := '{}'; v_last timestamptz;
BEGIN
  SELECT w.timezone INTO v_tz FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF v_tz IS NULL THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  WITH sel AS (
    SELECT pl.* FROM public.plans pl
     WHERE pl.workspace_id = p_workspace_id AND p_plan_ids IS NOT NULL AND pl.id = ANY (p_plan_ids[1:200])
    UNION ALL
    SELECT q.* FROM (
      SELECT pl.* FROM public.plans pl
       WHERE pl.workspace_id = p_workspace_id AND p_plan_ids IS NULL
         AND (NOT p_only_shared OR pl.audience = 'client')
         AND (p_range_start IS NULL OR (pl.starts_on <= p_range_end AND pl.ends_on >= p_range_start))
         AND (p_before_starts_on IS NULL OR (pl.starts_on, pl.id) < (p_before_starts_on, p_before_id))
       ORDER BY pl.starts_on DESC, pl.id DESC
       LIMIT c_page + 1) q),
  page AS (
    SELECT s.*, row_number() OVER (ORDER BY s.starts_on DESC, s.id DESC) rn FROM sel s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'workspace_id', p.workspace_id, 'title', p.title, 'starts_on', p.starts_on,
           'ends_on', p.ends_on, 'audience', p.audience, 'created_by', p.created_by, 'updated_at', p.updated_at) ORDER BY p.starts_on, p.id)
           FILTER (WHERE p_plan_ids IS NOT NULL OR p.rn <= c_page), '[]'),
         coalesce(array_agg(p.id) FILTER (WHERE p_plan_ids IS NOT NULL OR p.rn <= c_page), '{}'),
         min(p.created_at) FILTER (WHERE p_plan_ids IS NOT NULL OR p.rn <= c_page),
         p_plan_ids IS NULL AND count(*) > c_page,
         (SELECT jsonb_build_object('starts_on', x.starts_on, 'id', x.id) FROM page x WHERE x.rn = c_page)
    INTO v_plans, v_ids, v_created, v_more, v_next
    FROM page p;
  IF NOT v_more THEN v_next := NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', it.id, 'plan_id', it.plan_id, 'kind', it.kind, 'position', it.position, 'title', it.title,
           'description', it.description, 'post_id', it.post_id, 'created_at', it.created_at, 'updated_at', it.updated_at, 'target_date', it.target_date, 'linked_post_id', it.linked_post_id)), '[]'),
         coalesce(array_agg(it.id), '{}'), coalesce(array_agg(coalesce(it.post_id, it.linked_post_id)) FILTER (WHERE coalesce(it.post_id, it.linked_post_id) IS NOT NULL), '{}'),
         coalesce(array_agg(it.id) FILTER (WHERE it.kind = 'concept'), '{}')
    INTO v_items, v_item_ids, v_post_ids, v_concept_ids
    FROM public.plan_items it WHERE it.plan_id = ANY (v_ids);
  IF cardinality(v_ids) > 0 THEN
    FOR v_chunk IN 0 .. (cardinality(v_ids) - 1) / 100 LOOP
      v_drafts := v_drafts || coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM public.plan_draft_rows(v_ids[v_chunk*100+1 : v_chunk*100+100]) d), '[]');
    END LOOP;
  END IF;
  IF p_plan_ids IS NULL AND p_range_start IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'stage', p.stage, 'target_date', p.target_date) ORDER BY p.target_date, p.id), '[]'),
           coalesce(array_agg(p.id), '{}')
      INTO v_loose, v_loose_ids
      FROM public.posts p
     WHERE p.workspace_id = p_workspace_id AND p.deleted_at IS NULL
       AND p.target_date >= ((p_range_start - 1)::timestamp AT TIME ZONE 'UTC')
       AND p.target_date <= (((p_range_end + 1)::timestamp + interval '23:59:59') AT TIME ZONE 'UTC');
  END IF;
  IF p_channel_id IS NOT NULL AND cardinality(v_ids) = 1 THEN
    EXECUTE format($q$SELECT max(m.created_at) FROM public.chat_messages m WHERE m.channel_id = $1 AND m.shared_plan_ids @> ARRAY[$2]::uuid[]
      AND m.deleted_at IS NULL AND m.created_at >= %L::timestamptz AND m.created_at < %L::timestamptz$q$,
      to_char(v_created at time zone 'UTC', c_ts), to_char((now() + interval '1 minute') at time zone 'UTC', c_ts))
    INTO v_last USING p_channel_id, v_ids[1];
  END IF;
  RETURN jsonb_build_object(
    'timezone', v_tz, 'plans', v_plans, 'items', v_items, 'draft_rows', v_drafts,
    'next_cursor', v_next,
    'reviews', (SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', r.item_id, 'side', r.side, 'status', r.status,
                  'reviewed_by', r.reviewed_by, 'reviewed_at', r.reviewed_at)), '[]') FROM public.plan_item_reviews r WHERE r.item_id = ANY (v_item_ids)),
    'posts', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'stage', p.stage, 'title', p.title, 'format', p.format, 'target_date', p.target_date, 'deleted', p.deleted_at IS NOT NULL)), '[]')
                FROM public.posts p WHERE p.id = ANY (v_post_ids)),
    'comment_counts', (SELECT coalesce(jsonb_object_agg(c.item_id, c.n), '{}') FROM (SELECT pc.item_id, count(*) n FROM public.plan_item_comments pc
                         WHERE pc.item_id = ANY (v_item_ids) AND pc.deleted_at IS NULL GROUP BY 1) c),
    'thumbs', jsonb_build_object(
      'posts', (SELECT coalesce(jsonb_object_agg(t.entity_id, t.v), '{}') FROM (
                  SELECT DISTINCT ON (aa.entity_id) aa.entity_id, aa.asset_version_id v
                    FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                   WHERE aa.entity_type = 'post' AND aa.entity_id = ANY (ARRAY(SELECT x::text FROM unnest(v_post_ids || v_loose_ids) x))
                     AND aa.deleted_at IS NULL AND av.mime_type LIKE 'image/%'
                   ORDER BY aa.entity_id, aa.position, aa.attached_at) t),
      'concepts', (SELECT coalesce(jsonb_object_agg(t.entity_id, CASE WHEN t.v IS NOT NULL THEN jsonb_build_object('kind', 'image', 'versionId', t.v)
                                                                       ELSE jsonb_build_object('kind', 'file') END), '{}') FROM (
                  SELECT aa.entity_id, (array_agg(aa.asset_version_id ORDER BY aa.position, aa.attached_at) FILTER (WHERE av.mime_type LIKE 'image/%'))[1] v
                    FROM public.asset_attachments aa JOIN public.asset_versions av ON av.id = aa.asset_version_id
                   WHERE aa.entity_type = 'plan_item' AND aa.entity_id = ANY (ARRAY(SELECT x::text FROM unnest(v_concept_ids) x)) AND aa.deleted_at IS NULL
                   GROUP BY aa.entity_id) t)),
    'also_in', CASE WHEN p_plan_ids IS NOT NULL AND cardinality(v_ids) = 1 THEN
                 (SELECT coalesce(jsonb_object_agg(a.post_id, a.titles), '{}') FROM (
                    SELECT o.post_id, jsonb_agg(pl.title ORDER BY pl.title) titles
                      FROM (SELECT DISTINCT it.post_id, it.plan_id FROM public.plan_items it
                             WHERE it.post_id = ANY (v_post_ids) AND it.deleted_at IS NULL AND it.plan_id <> v_ids[1]) o
                      JOIN public.plans pl ON pl.id = o.plan_id GROUP BY o.post_id) a) END,
    'loose_posts', v_loose,
    'any_plan', CASE WHEN cardinality(v_ids) > 0 THEN true
                     WHEN p_plan_ids IS NULL AND p_range_start IS NOT NULL THEN EXISTS (SELECT 1 FROM public.plans pl
                       WHERE pl.workspace_id = p_workspace_id AND (NOT p_only_shared OR pl.audience = 'client'))
                     ELSE false END,
    'last_sent_at', v_last);
END $function$
;
REVOKE ALL ON FUNCTION public.plan_bundle_read(p_trace_id uuid, p_workspace_id uuid, p_plan_ids uuid[], p_range_start date, p_range_end date, p_only_shared boolean, p_channel_id text, p_before_starts_on date, p_before_id uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.plan_bundle_read(p_trace_id uuid, p_workspace_id uuid, p_plan_ids uuid[], p_range_start date, p_range_end date, p_only_shared boolean, p_channel_id text, p_before_starts_on date, p_before_id uuid) TO authenticated;
