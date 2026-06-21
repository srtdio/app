-- Already applied via MCP on the v2 project. Recorded for migration parity. Do NOT re-run.
ALTER TABLE public.comments
  ADD COLUMN legacy_author_name  text,
  ADD COLUMN legacy_author_email text,
  ADD CONSTRAINT comments_legacy_author_name_len
    CHECK (legacy_author_name IS NULL OR char_length(legacy_author_name) BETWEEN 1 AND 120),
  ADD CONSTRAINT comments_legacy_author_email_len
    CHECK (legacy_author_email IS NULL OR char_length(legacy_author_email) BETWEEN 3 AND 320);
