-- Already applied via MCP on the v2 project. Recorded for migration parity.
-- legacy_author_name preserves the original v1 creator/editor display name on
-- migrated posts, briefs, and post versions whose *_by author was set NULL at
-- cutover (rendered as the author, falling back to "(ex-member)"). Plain nullable
-- text, no constraints. Do NOT re-run on the live project (already applied there).
ALTER TABLE public.posts         ADD COLUMN legacy_author_name text;
ALTER TABLE public.briefs        ADD COLUMN legacy_author_name text;
ALTER TABLE public.post_versions ADD COLUMN legacy_author_name text;
