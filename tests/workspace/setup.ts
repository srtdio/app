// Vitest globalSetup for the workspace suite. Reuses the RLS suite's local
// Supabase bring-up verbatim: same ephemeral container, same applied migrations
// (so member_invite / member_accept and the tenant email tables exist), and the
// same temp env handoff file. Nothing here touches the live database.
export { setup, teardown } from '../rls/setup';
