-- Live (v2) asset_versions_kind_shape_check is stricter than 20260609120000 recorded:
-- every stored kind must also carry r2_key, sha256 and mime_type. The sample week's
-- versions had no sha256, so induction_sample_seed failed on its first file and every
-- first tour ran in an empty workspace. This aligns the check with live and gives each
-- sample file a digest of its key. It is deliberately not the file's content digest:
-- an upload of the same bytes must never dedupe onto a sample row that is later cleared.
--
-- Also: a pending invite no longer clears the sample (below).
-- Applied to v2 (movnexawfhsyuluspxoc) on 2026-10-18 via Supabase MCP.

ALTER TABLE public.asset_versions DROP CONSTRAINT IF EXISTS asset_versions_kind_shape_check;
ALTER TABLE public.asset_versions ADD CONSTRAINT asset_versions_kind_shape_check CHECK (
  (kind = 'link' AND external_url IS NOT NULL AND r2_key IS NULL AND sha256 IS NULL
     AND size_bytes IS NULL AND mime_type IS NULL)
  OR
  (kind <> 'link' AND external_url IS NULL AND r2_key IS NOT NULL AND sha256 IS NOT NULL
     AND size_bytes IS NOT NULL AND mime_type IS NOT NULL));

CREATE OR REPLACE FUNCTION public._induction_sample_asset(p_workspace_id uuid, p_by uuid, p_at timestamptz,
  p_file text, p_filename text, p_display_name text, p_kind text, p_mime text, p_size bigint,
  p_width integer, p_height integer, p_pages integer, p_duration_ms integer, p_origin text,
  OUT asset_id uuid, OUT version_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.assets (workspace_id, filename, display_name, uploaded_by, uploaded_at, origin)
  VALUES (p_workspace_id, p_filename, p_display_name, p_by, p_at, p_origin)
  RETURNING id INTO asset_id;
  INSERT INTO public.asset_versions (asset_id, workspace_id, version_number, r2_key, mime_type, sha256,
                                     size_bytes, width, height, duration_ms, page_count, uploaded_by,
                                     uploaded_at, kind)
  VALUES (asset_id, p_workspace_id, 1, 'induction-sample/' || p_file, p_mime,
          encode(sha256(('induction-sample/' || p_file)::bytea), 'hex'),
          p_size, p_width, p_height, p_duration_ms, p_pages, p_by, p_at, p_kind)
  RETURNING id INTO version_id;
  UPDATE public.assets SET current_version_id = version_id WHERE id = asset_id;
  PERFORM public._induction_sample_mark(p_workspace_id, 'asset', asset_id::text);
  PERFORM public._induction_sample_mark(p_workspace_id, 'asset_version', version_id::text);
END; $function$;
REVOKE EXECUTE ON FUNCTION public._induction_sample_asset(uuid, uuid, timestamptz, text, text, text, text, text, bigint, integer, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;

-- An invite row is not a member joining: the creator invites the approver before the
-- look-around, and the sample must still be there for it. The sample clears when an
-- invitee accepts (the row becomes active or accepted), or when an already-active row
-- is inserted (a direct add); a pending invite leaves it alone.
CREATE OR REPLACE FUNCTION public._induction_sample_member_joined()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_trace text := current_setting('app.trace_id', true);
BEGIN
  IF NEW.user_id = ANY (public._induction_sample_people()) OR NEW.role = 'owner' THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' AND NOT (NEW.active OR NEW.accepted_at IS NOT NULL) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NOT ((NEW.active AND NOT OLD.active)
                               OR (NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL)) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = NEW.workspace_id AND owner_user_id = NEW.user_id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.induction_sample_rows WHERE workspace_id = NEW.workspace_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.induction_sample_seeds
              WHERE workspace_id = NEW.workspace_id AND cleared_at IS NULL AND seeded_by = NEW.user_id) THEN
    RETURN NULL;
  END IF;
  PERFORM public._induction_sample_clear(NEW.workspace_id,
    CASE WHEN v_trace ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN v_trace::uuid ELSE public.uuidv7() END,
    'member_joined');
  RETURN NULL;
END; $function$;

REVOKE EXECUTE ON FUNCTION public._induction_sample_member_joined() FROM PUBLIC, anon, authenticated;
