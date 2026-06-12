-- Grant the asset read/write table privileges the service_role needs for the
-- asset-upload worker (link create + rename + version append + audit logging).
-- Context: the worker connects as service_role and bypasses RLS, but still needs
-- table-level grants; these were missing and were applied live via the Supabase
-- MCP on 11-12 June 2026. This file records them for fresh-database builds.
-- GRANT is idempotent, so replaying it against the live database is safe.
GRANT SELECT ON public.assets TO service_role;
GRANT SELECT ON public.asset_versions TO service_role;
GRANT SELECT ON public.workspaces TO service_role;
GRANT SELECT ON public.workspace_members TO service_role;
GRANT INSERT ON public.assets TO service_role;
GRANT UPDATE ON public.assets TO service_role;
GRANT INSERT ON public.asset_versions TO service_role;
GRANT INSERT ON public.audit_log TO service_role;
