-- Asset kinds, external links, and renditions.
--
-- RECORD ONLY. This schema was ALREADY APPLIED to live v2 (Supabase project
-- movnexawfhsyuluspxoc) via the Supabase MCP. This file exists so the
-- migration history matches the live database. DO NOT re-run it. Do not
-- execute `supabase db push` or any apply/migrate command against live for
-- this PR. All asset tables were empty when applied; no data backfill.

-- ---------------------------------------------------------------------------
-- asset_versions: introduce `kind`, support external links, and relax the
-- binary-payload columns so link-kind versions need no R2 object.
-- ---------------------------------------------------------------------------

-- New columns. `kind` has no default; every row must declare its shape.
ALTER TABLE public.asset_versions
  ADD COLUMN kind text NOT NULL,
  ADD COLUMN external_url text;

ALTER TABLE public.asset_versions
  ADD CONSTRAINT asset_versions_kind_check
    CHECK (kind IN ('image', 'video', 'audio', 'pdf', 'document', 'spreadsheet', 'presentation', 'link')),
  ADD CONSTRAINT asset_versions_external_url_check
    CHECK ((external_url IS NULL) OR (external_url ~ '^https?://'));

-- The R2 payload columns are no longer mandatory: link-kind versions carry an
-- external_url instead of a stored object.
ALTER TABLE public.asset_versions
  ALTER COLUMN r2_key DROP NOT NULL,
  ALTER COLUMN mime_type DROP NOT NULL,
  ALTER COLUMN sha256 DROP NOT NULL,
  ALTER COLUMN size_bytes DROP NOT NULL;

-- Relax the digest/size checks to tolerate NULLs (link kinds have neither).
ALTER TABLE public.asset_versions
  DROP CONSTRAINT asset_versions_sha256_check,
  DROP CONSTRAINT asset_versions_size_bytes_check;

ALTER TABLE public.asset_versions
  ADD CONSTRAINT asset_versions_sha256_check
    CHECK ((sha256 IS NULL) OR (sha256 ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT asset_versions_size_bytes_check
    CHECK ((size_bytes IS NULL) OR (size_bytes > 0));

-- Shape invariant: link kinds point at an external_url and store no bytes;
-- every other kind stores bytes and carries no external_url.
ALTER TABLE public.asset_versions
  ADD CONSTRAINT asset_versions_kind_shape_check
    CHECK (
      (kind = 'link' AND external_url IS NOT NULL AND size_bytes IS NULL)
      OR
      (kind <> 'link' AND size_bytes IS NOT NULL AND external_url IS NULL)
    );

-- r2_key uniqueness must skip NULLs (link kinds have no key), so the full
-- UNIQUE constraint is replaced by a partial unique index.
ALTER TABLE public.asset_versions
  DROP CONSTRAINT asset_versions_r2_key_key;

CREATE UNIQUE INDEX asset_versions_r2_key_key
  ON public.asset_versions (r2_key)
  WHERE r2_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- asset_renditions: derived encodings (compressed / preview / thumbnail) of a
-- given asset_version. Always R2-backed.
-- ---------------------------------------------------------------------------

CREATE TABLE public.asset_renditions (
  id uuid NOT NULL DEFAULT uuidv7(),
  asset_version_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  role text NOT NULL,
  r2_key text NOT NULL,
  mime_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  width integer,
  height integer,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_renditions_pkey PRIMARY KEY (id),
  CONSTRAINT asset_renditions_r2_key_key UNIQUE (r2_key),
  CONSTRAINT asset_renditions_asset_version_id_role_key UNIQUE (asset_version_id, role),
  CONSTRAINT asset_renditions_asset_version_id_fkey FOREIGN KEY (asset_version_id) REFERENCES public.asset_versions(id) ON DELETE CASCADE,
  CONSTRAINT asset_renditions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT asset_renditions_role_check CHECK (role IN ('compressed', 'preview', 'thumbnail')),
  CONSTRAINT asset_renditions_sha256_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT asset_renditions_size_bytes_check CHECK (size_bytes > 0),
  CONSTRAINT asset_renditions_width_check CHECK ((width IS NULL) OR (width > 0)),
  CONSTRAINT asset_renditions_height_check CHECK ((height IS NULL) OR (height > 0)),
  CONSTRAINT asset_renditions_duration_ms_check CHECK ((duration_ms IS NULL) OR (duration_ms > 0))
);

ALTER TABLE public.asset_renditions ENABLE ROW LEVEL SECURITY;

CREATE POLICY asset_renditions_select ON public.asset_renditions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = asset_renditions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));
