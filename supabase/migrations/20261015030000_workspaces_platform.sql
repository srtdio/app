-- Induction 1/7: workspaces.platform. One workspace = one client = one platform.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; this file records it.
-- The column existed live but was never recorded in any migration.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS platform text;

-- Backfill. The row_version guard rejects updates that do not bump row_version.
UPDATE public.workspaces SET platform = 'linkedin', row_version = row_version + 1 WHERE platform IS NULL;

-- DESTRUCTIVE: constraint swap only, no row or column dropped. Rollback: re-add the previous constraint text:
-- CHECK ((platform IS NULL) OR (platform = ANY (ARRAY['linkedin'::text, 'instagram'::text, 'facebook'::text, 'x'::text, 'youtube'::text, 'tiktok'::text])))
ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_platform_check;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_platform_check
  CHECK ((platform = ANY (ARRAY['instagram'::text, 'x'::text, 'threads'::text, 'linkedin'::text, 'facebook'::text, 'tiktok'::text, 'youtube_shorts'::text])));

ALTER TABLE public.workspaces ALTER COLUMN platform SET NOT NULL;
