-- Induction 3/7: per-platform formats for posts and briefs; posts.platform follows the workspace.
-- Applied to v2 (movnexawfhsyuluspxoc) via Supabase MCP on 15 Oct 2026; this file records it.

-- DESTRUCTIVE: constraint swap only, no row or column dropped. Rollback: re-add the previous constraint text:
-- CHECK ((format = ANY (ARRAY['text'::text, 'single_image'::text, 'carousel'::text, 'video'::text, 'link'::text])))
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_format_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_format_check
  CHECK ((format = ANY (ARRAY['text'::text, 'single_image'::text, 'carousel'::text, 'video'::text, 'link'::text, 'reel'::text, 'story'::text, 'thread'::text, 'short'::text])));

-- DESTRUCTIVE: constraint swap only, no row or column dropped. Rollback: re-add the previous constraint text:
-- CHECK ((platform = ANY (ARRAY['linkedin'::text, 'x'::text, 'instagram'::text, 'facebook'::text, 'threads'::text])))
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_platform_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_platform_check
  CHECK ((platform = ANY (ARRAY['instagram'::text, 'x'::text, 'threads'::text, 'linkedin'::text, 'facebook'::text, 'tiktok'::text, 'youtube_shorts'::text])));

-- DESTRUCTIVE: constraint swap only, no row or column dropped. Rollback: re-add the previous constraint text:
-- CHECK (((format_requested IS NULL) OR (format_requested = ANY (ARRAY['text'::text, 'single_image'::text, 'carousel'::text, 'video'::text, 'link'::text]))))
ALTER TABLE public.briefs DROP CONSTRAINT IF EXISTS briefs_format_requested_check;
ALTER TABLE public.briefs ADD CONSTRAINT briefs_format_requested_check
  CHECK (((format_requested IS NULL) OR (format_requested = ANY (ARRAY['text'::text, 'single_image'::text, 'carousel'::text, 'video'::text, 'link'::text, 'reel'::text, 'story'::text, 'thread'::text, 'short'::text]))));

-- Data fix: a post's platform is its workspace's platform. The row_version guard requires +1.
UPDATE public.posts p SET platform = w.platform, row_version = p.row_version + 1
  FROM public.workspaces w
 WHERE w.id = p.workspace_id AND p.platform <> w.platform;
