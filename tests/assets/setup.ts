// Vitest globalSetup for the assets suite. Reuses the RLS suite's local Supabase
// bring-up verbatim: same ephemeral container, the same applied migrations (so
// the assets RLS policies and assets_ws_uploaded_id_idx are present), and the
// same temp env handoff file. Nothing here touches the live database.
export { setup, teardown } from '../rls/setup';
