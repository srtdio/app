-- Record of change applied to live DB via MCP on 2026-07-11. Do not re-run manually.
ALTER TABLE public.workspaces ADD COLUMN key text;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{1,4}$');
CREATE UNIQUE INDEX workspaces_key_unique ON public.workspaces (key);
CREATE TABLE public.workspace_counters (workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE, next_entity_number integer NOT NULL DEFAULT 1 CHECK (next_entity_number > 0));
ALTER TABLE public.workspace_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_counters FROM PUBLIC, anon, authenticated;
ALTER TABLE public.posts ADD COLUMN number integer;
ALTER TABLE public.briefs ADD COLUMN number integer;
CREATE OR REPLACE FUNCTION public.workspace_counters_seed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  INSERT INTO public.workspace_counters (workspace_id, next_entity_number) VALUES (NEW.id, 1) ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.workspace_counters_seed() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER workspaces_seed_counter AFTER INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.workspace_counters_seed();
UPDATE public.workspaces SET key = 'GBL', row_version = row_version + 1 WHERE id = '019eb006-0494-7d69-8fc4-d5a3ce8b114c';
UPDATE public.workspaces SET key = 'CV', row_version = row_version + 1 WHERE id = '019ed064-6939-7527-ab5d-7deddb8731ef';
DO $$
BEGIN
  ALTER TABLE public.posts  DISABLE TRIGGER posts_row_version_check;
  ALTER TABLE public.briefs DISABLE TRIGGER briefs_row_version_check;
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS rn
    FROM (SELECT id, workspace_id, created_at FROM public.posts
          UNION ALL SELECT id, workspace_id, created_at FROM public.briefs) e)
  UPDATE public.posts p SET number = r.rn FROM ranked r WHERE p.id = r.id;
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS rn
    FROM (SELECT id, workspace_id, created_at FROM public.posts
          UNION ALL SELECT id, workspace_id, created_at FROM public.briefs) e)
  UPDATE public.briefs b SET number = r.rn FROM ranked r WHERE b.id = r.id;
  ALTER TABLE public.posts  ENABLE TRIGGER posts_row_version_check;
  ALTER TABLE public.briefs ENABLE TRIGGER briefs_row_version_check;
  INSERT INTO public.workspace_counters (workspace_id, next_entity_number)
  SELECT w.id, 1 + coalesce((SELECT max(x.n) FROM (
      SELECT number AS n FROM public.posts WHERE workspace_id = w.id
      UNION ALL SELECT number FROM public.briefs WHERE workspace_id = w.id) x), 0)
  FROM public.workspaces w
  ON CONFLICT (workspace_id) DO UPDATE SET next_entity_number = EXCLUDED.next_entity_number;
END $$;
CREATE OR REPLACE FUNCTION public.post_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_id uuid; v_title text; v_platform text; v_format text;
  v_origin text; v_owner uuid; v_brief uuid; v_number integer;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id,'post.create') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  v_title    := p_payload->>'title';
  v_platform := p_payload->>'platform';
  IF v_title IS NULL OR v_platform IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_format := coalesce(p_payload->>'format','text');
  v_origin := coalesce(p_payload->>'origin','manual');
  v_owner  := coalesce((p_payload->>'owner_user_id')::uuid, auth.uid());
  v_brief  := (p_payload->>'brief_id')::uuid;
  IF v_origin = 'brief' AND v_brief IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.workspace_counters
     SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id
   RETURNING next_entity_number - 1 INTO v_number;
  IF v_number IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
  BEGIN
    INSERT INTO public.posts (workspace_id, number, title, caption, bucket_id, owner_user_id,
      platform, format, origin, brief_id, target_date, created_by)
    VALUES (p_workspace_id, v_number, v_title, p_payload->>'caption', (p_payload->>'bucket_id')::uuid, v_owner,
      v_platform, v_format, v_origin, v_brief, (p_payload->>'target_date')::timestamptz, auth.uid())
    RETURNING id INTO v_id;
    INSERT INTO public.post_versions (post_id, workspace_id, version_number, snapshot, created_by)
    VALUES (v_id, p_workspace_id, 1,
      jsonb_build_object('title',v_title,'caption',p_payload->>'caption','platform',v_platform,
        'format',v_format,'target_date',p_payload->>'target_date','bucket_id',p_payload->>'bucket_id',
        'owner_user_id',v_owner,'origin',v_origin,'brief_id',v_brief),
      auth.uid());
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR datetime_field_overflow OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  PERFORM public.audit_log_write('post_create','success',p_trace_id,p_workspace_id,'post',v_id::text,
          jsonb_build_object('title',v_title,'stage','draft','origin',v_origin,'number',v_number));
  RETURN v_id;
END; $function$;
CREATE OR REPLACE FUNCTION public.brief_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_title text; v_obj text; v_version_ids uuid[]; v_uid uuid := auth.uid(); i int; v_number integer;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id, 'brief.create') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  v_title := p_payload->>'title'; v_obj := p_payload->>'objective';
  IF v_title IS NULL OR v_obj IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_payload ? 'attachment_asset_version_ids' THEN
    IF jsonb_typeof(p_payload->'attachment_asset_version_ids') <> 'array' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    BEGIN
      SELECT array_agg(value::uuid) INTO v_version_ids
      FROM jsonb_array_elements_text(p_payload->'attachment_asset_version_ids');
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_payload';
    END;
  END IF;
  IF v_version_ids IS NOT NULL AND array_length(v_version_ids,1) IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(v_version_ids) av(id)
               LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=p_workspace_id
               WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  END IF;
  UPDATE public.workspace_counters
     SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id
   RETURNING next_entity_number - 1 INTO v_number;
  IF v_number IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
  BEGIN
    INSERT INTO public.briefs (workspace_id, number, title, objective, format_requested, brand_requirements,
      target_date, reference_links, created_by, created_via)
    VALUES (p_workspace_id, v_number, v_title, v_obj, p_payload->>'format_requested', p_payload->>'brand_requirements',
      (p_payload->>'target_date')::date, p_payload->'reference_links', v_uid,
      coalesce(p_payload->>'created_via','app'))
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF v_version_ids IS NOT NULL AND array_length(v_version_ids,1) IS NOT NULL THEN
    FOR i IN 1..array_length(v_version_ids,1) LOOP
      INSERT INTO public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      SELECT v.asset_id, v.id, 'brief', v_id::text, p_workspace_id, i-1, v_uid
      FROM public.asset_versions v WHERE v.id=v_version_ids[i];
    END LOOP;
  END IF;
  PERFORM public.audit_log_write(p_action=>'brief_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'brief', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('title', v_title, 'attachments', coalesce(array_length(v_version_ids,1),0), 'number', v_number));
  RETURN v_id;
END; $function$;
CREATE OR REPLACE FUNCTION public.workspace_create(p_payload jsonb, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
  v_timezone text;
  v_key text;
  v_base text;
  v_candidate text;
  i int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  v_name     := p_payload->>'name';
  v_timezone := p_payload->>'timezone';
  IF v_name IS NULL OR v_timezone IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_key := nullif(upper(trim(coalesce(p_payload->>'key',''))),'');
  IF v_key IS NOT NULL THEN
    IF v_key !~ '^[A-Z][A-Z0-9]{1,4}$' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    IF EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_key) THEN
      RAISE EXCEPTION 'workspace_key_taken';
    END IF;
  ELSE
    SELECT string_agg(left(w,1),'') INTO v_base
      FROM regexp_split_to_table(trim(regexp_replace(upper(v_name),'[^A-Z0-9 ]','','g')),'\s+') AS w
     WHERE w <> '';
    IF v_base IS NULL OR length(v_base) < 2 THEN
      v_base := left(regexp_replace(upper(v_name),'[^A-Z0-9]','','g'),4);
    END IF;
    IF v_base IS NULL OR length(v_base) < 2 OR v_base !~ '^[A-Z]' THEN
      v_base := 'WS';
    END IF;
    v_base := left(v_base,5);
    IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_base) THEN
      v_key := v_base;
    ELSE
      FOR i IN 2..9 LOOP
        v_candidate := left(v_base,4) || i::text;
        IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE key = v_candidate) THEN
          v_key := v_candidate; EXIT;
        END IF;
      END LOOP;
    END IF;
    IF v_key IS NULL THEN RAISE EXCEPTION 'workspace_key_taken'; END IF;
  END IF;
  BEGIN
    INSERT INTO public.workspaces (name, owner_user_id, timezone, key)
    VALUES (v_name, v_uid, v_timezone, v_key)
    RETURNING id INTO v_id;
    INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
    VALUES (v_id, v_uid, 'owner', now());
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'workspace_key_taken';
    WHEN check_violation OR not_null_violation OR invalid_text_representation
      OR foreign_key_violation THEN RAISE EXCEPTION 'invalid_payload';
  END;
  PERFORM public.audit_log_write('workspace_create','success',p_trace_id,v_id,'workspace',v_id::text,
          jsonb_build_object('name',v_name,'timezone',v_timezone,'key',v_key));
  RETURN v_id;
END;
$function$;
ALTER TABLE public.posts ALTER COLUMN number SET NOT NULL;
ALTER TABLE public.briefs ALTER COLUMN number SET NOT NULL;
ALTER TABLE public.posts ADD CONSTRAINT posts_workspace_number_unique UNIQUE (workspace_id, number);
ALTER TABLE public.briefs ADD CONSTRAINT briefs_workspace_number_unique UNIQUE (workspace_id, number);
ALTER TABLE public.workspaces ALTER COLUMN key SET NOT NULL;
