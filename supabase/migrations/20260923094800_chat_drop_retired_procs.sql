-- DESTRUCTIVE: drop retired chat procs. Applied to live 2026-09-23 via MCP.
-- Rollback: re-run the CREATE FUNCTION bodies from 20260613070000 (chat_webhook_ingest) and 20260710153728 (chat_message_save).
DROP FUNCTION IF EXISTS public.chat_webhook_ingest(text, text, boolean, jsonb, text, text, text, uuid, text, jsonb, uuid[], timestamptz, uuid);
DROP FUNCTION IF EXISTS public.chat_message_save(text, text, timestamptz, text, jsonb, uuid[], uuid);
-- END MIGRATION
