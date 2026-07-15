// @srtdio/schemas: single source of truth for data shapes shared by the
// frontend and backend. Re-exports from the sub-modules below.

// Supabase row/insert/update types generated from the live database schema.
export * from './supabase.generated';

// Zod schemas, one file per live table. Keep alphabetical by table name.
export * from './zod/asset_attachments';
export * from './zod/asset_versions';
export * from './zod/assets';
export * from './zod/audit_log';
export * from './zod/briefs';
export * from './zod/chat_channels';
export * from './zod/chat_messages';
export * from './zod/cockpit_access_log';
export * from './zod/cockpit_procedure_allowlist';
export * from './zod/comment_reactions';
export * from './zod/comments';
export * from './zod/delivery_attempts';
export * from './zod/email_threads';
export * from './zod/feature_flags';
export * from './zod/group_members';
export * from './zod/groups';
export * from './zod/idempotency_keys';
export * from './zod/inbox_entries';
export * from './zod/intent_ledger';
export * from './zod/pending_flows';
export * from './zod/platform_operators';
export * from './zod/post_annotations';
export * from './zod/post_versions';
export * from './zod/posts';
export * from './zod/session_devices';
export * from './zod/users';
export * from './zod/webhook_events';
export * from './zod/webhook_processing_attempts';
export * from './zod/workspace_buckets';
export * from './zod/workspace_members';
export * from './zod/workspace_onboarding';
export * from './zod/workspace_role_permissions';
export * from './zod/workspace_settings';
export * from './zod/workspaces';
