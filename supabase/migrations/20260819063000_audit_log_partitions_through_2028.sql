-- audit_log monthly partitions, 2026-08 through 2028-12, plus a DEFAULT partition.
--
-- ALREADY APPLIED to live (movnexawfhsyuluspxoc) via the Supabase MCP on 2026-08-19.
-- This file exists so a fresh database provisioned from supabase/migrations/ matches
-- live. DO NOT EXECUTE MANUALLY.
--
-- Background: the MVP baseline creates only audit_log_2026_05/06/07. Live grew past
-- that window on 2026-08-01, and every write path calls public.audit_log_write(), so
-- CI databases built from migrations alone started failing with
--   no partition of relation "audit_log" found for row
-- Idempotent and non-destructive: CREATE TABLE IF NOT EXISTS only, no DROP, no TRUNCATE.
-- 2026_05/06/07 are deliberately not recreated here; the baseline owns them.

DO $$
DECLARE
  m date;
BEGIN
  FOR m IN
    SELECT generate_series('2026-08-01'::date, '2028-12-01'::date, '1 month'::interval)::date
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.audit_log_%s PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYY_MM'),
      m,
      (m + interval '1 month')::date
    );
  END LOOP;
END
$$;

-- Permanent backstop: with a DEFAULT partition an audit write can never fail on a missing month.
CREATE TABLE IF NOT EXISTS public.audit_log_default PARTITION OF public.audit_log DEFAULT;
