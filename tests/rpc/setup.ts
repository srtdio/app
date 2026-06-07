// Vitest globalSetup for the RPC suite. Reuses the RLS suite's local Supabase
// bring-up verbatim: same ephemeral container, the same applied migrations (so
// the SECURITY DEFINER procs are present), and the same temp env handoff file.
// Nothing here touches the live database.
export { setup, teardown } from '../rls/setup';
