// Vitest globalSetup for the briefs suite. Reuses the RLS suite's local Supabase
// bring-up verbatim: same ephemeral container, the same applied migrations (so
// the brief_create / brief_close procs and the briefs RLS policies are present),
// and the same temp env handoff file. Nothing here touches the live database.
export { setup, teardown } from '../rls/setup';
