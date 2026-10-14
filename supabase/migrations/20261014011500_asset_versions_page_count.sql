-- Applied live 14 Oct 2026 via MCP. Recording only.

ALTER TABLE public.asset_versions
  ADD COLUMN page_count integer NULL,
  ADD CONSTRAINT asset_versions_page_count_check
    CHECK (page_count IS NULL OR (kind = 'pdf' AND page_count BETWEEN 1 AND 10000));
