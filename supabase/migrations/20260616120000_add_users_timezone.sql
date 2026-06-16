-- ALREADY APPLIED to v2 via Supabase MCP on 2026-06-16. Ledger record only.
-- Do NOT re-run. Do NOT `supabase db push`.
ALTER TABLE public.users ADD COLUMN timezone text;
COMMENT ON COLUMN public.users.timezone IS 'IANA tz name. NULL falls back to workspaces.timezone for catch-up email scheduling. App-validated; no DB CHECK.';
