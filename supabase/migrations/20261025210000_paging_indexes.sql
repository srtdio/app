-- Already applied live to movnexawfhsyuluspxoc on 2026-10-25
CREATE INDEX IF NOT EXISTS assets_ws_uploaded_id_idx ON public.assets (workspace_id, uploaded_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS briefs_ws_created_id_idx ON public.briefs (workspace_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
