-- Posts full-text search index (title + caption). Schema already applied to movnexawfhsyuluspxoc. Do NOT execute.
-- Rounds out FTS coverage; mirrors briefs_title_fts_idx / comments_body_fts_idx / assets_filename_fts_idx
-- (gin, english regconfig, partial WHERE deleted_at IS NULL). Expression index, non-destructive.

CREATE INDEX IF NOT EXISTS posts_search_fts_idx
  ON public.posts
  USING gin (to_tsvector('english'::regconfig, ((coalesce(title, ''::text) || ' '::text) || coalesce(caption, ''::text))))
  WHERE (deleted_at IS NULL);
