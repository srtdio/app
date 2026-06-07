-- Grant SELECT to the authenticated role on tenant-readable tables.
-- Context: INSERT/UPDATE/DELETE remain revoked from authenticated (all writes go through SECURITY DEFINER procs).
-- SELECT was over-revoked, which blocked every direct RLS-governed read (workspaces, posts, briefs, etc).
-- RLS remains the row-level security boundary; this only restores table-level read access so policies can filter rows.
-- Already applied to the live database; this migration records it for reproducibility. Idempotent.
GRANT SELECT ON
  public.users, public.workspaces, public.workspace_members, public.workspace_settings,
  public.workspace_role_permissions, public.workspace_buckets,
  public.posts, public.post_versions, public.post_annotations,
  public.briefs, public.comments, public.comment_reactions,
  public.assets, public.asset_versions, public.asset_attachments,
  public.groups, public.group_members,
  public.inbox_entries, public.chat_channels
TO authenticated;
