-- Applied out of band 5 Oct 2026 on movnexawfhsyuluspxoc. No-op there; recorded for fresh databases.
--
-- asset_renditions privileges and indexes as they stand live. The table is
-- read and written only by the asset Workers through the service role:
-- asset-upload inserts the 'thumbnail' rendition of a pdf/video version (ON
-- CONFLICT DO NOTHING), asset-read reads it behind the parent version's own
-- read gate. Clients never read it directly: live, anon and authenticated hold
-- no SELECT (or write) grant, so the asset_renditions_select policy is
-- unreachable for them at the grant level. The REVOKE below reproduces that on
-- a fresh database, where Supabase default privileges would otherwise grant it.
--
-- Rollback: drop index public.asset_renditions_version_idx;
--           drop index public.asset_renditions_workspace_idx;
--           revoke select, insert on public.asset_renditions from service_role;

REVOKE ALL ON public.asset_renditions FROM anon, authenticated;

GRANT SELECT, INSERT ON public.asset_renditions TO service_role;

CREATE INDEX IF NOT EXISTS asset_renditions_version_idx
  ON public.asset_renditions USING btree (asset_version_id);

CREATE INDEX IF NOT EXISTS asset_renditions_workspace_idx
  ON public.asset_renditions USING btree (workspace_id);
