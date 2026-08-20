-- audit_log monthly partitions, 2026-08 through 2028-12, plus a DEFAULT partition.
--
-- This file RECORDS THE LIVE END STATE (movnexawfhsyuluspxoc). It is not a delta
-- against live and it is not a change request. DO NOT EXECUTE MANUALLY.
--
-- Coverage: monthly partitions for 2026-08 through 2028-12 on public.audit_log,
-- 29 months, plus a DEFAULT partition. Combined with the baseline's
-- audit_log_2026_05/06/07 that is 32 monthly partitions plus DEFAULT on the table.
-- 2026_05/06/07 are deliberately not recreated here; the baseline owns them, and
-- IF NOT EXISTS on those would mask a real conflict.
--
-- How live got there: the months through 2027-12 were created over time by the
-- scheduled public.ensure_future_partitions(3) (pg_cron job 'ensure-future-partitions',
-- schedule '0 3 1 * *'), which keeps three months ahead of the current date. The 2028
-- months and the DEFAULT partition were applied via the Supabase MCP on 2026-08-20.
-- This file records the resulting end state so a database provisioned from
-- supabase/migrations/ matches live.
--
-- Why it was needed: ensure_future_partitions is scheduled behind
-- IF to_regclass('cron.job') IS NOT NULL. CI containers have no pg_cron, so the guard
-- is false, the schedule is skipped, and a migration-built database stalls at the
-- baseline's three months. That is why every write suite failed from 2026-08-01 with
--   no partition of relation "audit_log" found for row
-- while live, where the cron job kept running, was never affected.
--
-- Idempotent and non-destructive: CREATE TABLE IF NOT EXISTS only, no DROP, no TRUNCATE.

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
