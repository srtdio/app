-- Already applied to live DB via MCP; committed retroactively. Do NOT re-execute manually.
--
-- Hardens the out-of-band `folders` table recorded by 20260613010000_asset_folders.sql.
-- That migration mirrored live exactly, where folders had its SELECT policy bound
-- to {public} and all CRUD grants revoked from anon/authenticated/service_role,
-- leaving folders_select_member unreachable for the app role and giving the
-- service-role asset worker no read/write path. This migration closes both gaps:
-- rebinds the SELECT policy to the authenticated role, grants authenticated the
-- workspace-gated SELECT, and grants service_role full CRUD for server-side
-- folder management (matching the asset table grant model). In CI's fresh
-- Postgres this executes as part of the migration chain after the folders table
-- exists; the statements are valid on a fresh DB.

DROP POLICY folders_select_member ON public.folders;
CREATE POLICY folders_select_member ON public.folders
  FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = folders.workspace_id
      AND wm.user_id = auth.uid() AND wm.active = true));
GRANT SELECT ON public.folders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folders TO service_role;
