-- ALREADY APPLIED to v2 via Supabase MCP on 2026-10-17. Ledger record only. Do NOT re-run.
GRANT SELECT ON public.inbox_entries, public.users, public.posts, public.briefs, public.chat_read_cursors TO service_role;
GRANT UPDATE (email_sent_at) ON public.inbox_entries TO service_role;
GRANT UPDATE (email_opt_in) ON public.users TO service_role;
