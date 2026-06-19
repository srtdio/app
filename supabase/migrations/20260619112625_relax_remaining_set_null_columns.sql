-- Already applied via MCP on the v2 project. Recorded for migration parity. Do NOT re-run.
ALTER TABLE asset_versions ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE asset_attachments ALTER COLUMN attached_by DROP NOT NULL;
ALTER TABLE groups ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE cockpit_procedure_allowlist ALTER COLUMN added_by DROP NOT NULL;
