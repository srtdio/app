-- Already applied via MCP on the v2 project. Recorded for migration parity. Do NOT re-run.
ALTER TABLE posts ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE posts ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE briefs ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE post_versions ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE assets ALTER COLUMN uploaded_by DROP NOT NULL;
