-- Schema already applied to live DB project_id=movnexawfhsyuluspxoc on 18 May 2026.
-- Do NOT execute. This file is repo housekeeping to keep migrations in sync with live state.
--
-- Stage taxonomy change: awaiting_approval -> review; needs_input removed.
-- Final stage set: draft, review, scheduled, published, parked, rejected.

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_stage_publish_status_check;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_stage_check;
ALTER TABLE posts ADD CONSTRAINT posts_stage_check CHECK (stage = ANY (ARRAY['draft', 'review', 'scheduled', 'published', 'parked', 'rejected']));
ALTER TABLE posts ADD CONSTRAINT posts_stage_publish_status_check CHECK (
  CASE stage
    WHEN 'draft' THEN (publish_status = 'draft')
    WHEN 'review' THEN (publish_status = 'draft')
    WHEN 'parked' THEN (publish_status = 'draft')
    WHEN 'rejected' THEN (publish_status = 'draft')
    WHEN 'scheduled' THEN (publish_status = ANY (ARRAY['scheduled', 'publishing', 'publish_failed', 'publish_failed_final']))
    WHEN 'published' THEN (publish_status = 'published')
    ELSE NULL::boolean
  END
);
