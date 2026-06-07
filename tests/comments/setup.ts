// Vitest globalSetup for the comments suite. Reuses the RLS suite's local
// Supabase bring-up verbatim: the same ephemeral container, the same applied
// migrations (so comment_create and the FTS index are present), and the same
// temp env handoff file. Nothing here touches the live database.
export { setup, teardown } from '../rls/setup';
