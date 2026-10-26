-- DESTRUCTIVE: applied by Shubham in SQL editor 26 Oct 2026. Rollback: recreate from 20261025233000_chat_partition_bounds.sql (3-arg function) and the original session_devices migration; table held 0 rows.
--
-- 1. Drops the 3-arg chat_thread_reply_counts (the app calls the 4-arg p_since
--    one) and the session_devices table (device fingerprinting is gone; JWT
--    60 minutes with silent refresh).
-- 2. Replay-grant fix: live grants are already correct; this makes a fresh
--    replay match them.

DROP FUNCTION IF EXISTS public.chat_thread_reply_counts(uuid, text, text[]);
DROP TABLE IF EXISTS public.session_devices;

REVOKE EXECUTE ON FUNCTION public.chat_read_cursor_set(text, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_read_cursor_set(text, text, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.chat_channel_clear(text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_channel_clear(text, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.chat_unread_counts(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts(uuid) TO authenticated;
