// @srtdio/schemas: single source of truth for data shapes shared by the
// frontend and backend. Re-exports from the sub-modules below.

// Supabase row/insert/update types generated from the live database schema.
export * from './supabase.generated';

// Zod schemas, one file per top-level domain.
export * from './zod/workspaces';
export * from './zod/workspace_members';
export * from './zod/workspace_role_permissions';
