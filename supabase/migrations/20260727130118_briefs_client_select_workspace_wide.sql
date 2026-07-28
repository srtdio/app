-- Replaces the client SELECT policy on briefs.
-- Old policy limited clients to briefs they authored (created_by = auth.uid()).
-- Clients must see every brief in their workspace, open and closed, read-only.
-- Policy replacement only. No data is destroyed. Already applied to live.

DROP POLICY IF EXISTS briefs_select_client_own ON public.briefs;

CREATE POLICY briefs_select_client ON public.briefs
FOR SELECT TO authenticated
USING (
  deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = briefs.workspace_id
      AND wm.user_id = auth.uid()
      AND wm.active = true
      AND wm.role = 'client'
  )
);
