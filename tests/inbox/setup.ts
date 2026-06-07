// Vitest globalSetup for the inbox-writer suite. Reuses the RLS suite's local
// Supabase bring-up verbatim: the same ephemeral container, the same applied
// migrations (so inbox_entry_create / audit_log_write exist), the same temp env
// handoff file. Nothing here touches the live database.
export { setup, teardown } from '../rls/setup';
