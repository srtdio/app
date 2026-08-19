-- inbox_entries and chat_messages monthly partitions, 2026-08 through 2028-12,
-- plus a DEFAULT partition on each.
--
-- Companion to 20260819063000_audit_log_partitions_through_2028.sql. All three
-- of public.audit_log, public.inbox_entries and public.chat_messages are
-- range-partitioned by month on created_at, and the MVP baseline creates only
-- 2026_05/06/07 for each of them. The audit_log migration closed that gap for
-- one table; the write-path suites then failed one step further along with
--   no partition of relation "inbox_entries" found for row
-- because the other two tables have exactly the same gap.
--
-- Unlike the audit_log migration this one is NOT purely a record of live. Live
-- is known to carry partitions for these two tables into 2026-12; whether it
-- has them beyond that has not been verified from this branch, and no SQL was
-- executed against any database here. Every statement is CREATE TABLE
-- IF NOT EXISTS, so applying it to live is a no-op for months already present.
--
-- Idempotent and non-destructive: no DROP, no TRUNCATE. 2026_05/06/07 are
-- deliberately not recreated; the baseline owns them and IF NOT EXISTS there
-- would mask a real conflict. No indexes, RLS policies, grants, or comments are
-- added: CREATE TABLE ... PARTITION OF copies relrowsecurity from the parent,
-- and the baseline already configures each parent.

DO $$
DECLARE
  v_tables text[] := ARRAY['inbox_entries','chat_messages'];
  v_tbl text;
  m date;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    FOR m IN
      SELECT generate_series('2026-08-01'::date, '2028-12-01'::date, '1 month'::interval)::date
    LOOP
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        format('%s_%s', v_tbl, to_char(m, 'YYYY_MM')),
        v_tbl,
        m,
        (m + interval '1 month')::date
      );
    END LOOP;
  END LOOP;
END
$$;

-- Permanent backstop on each table: a write can never fail on a missing month.
CREATE TABLE IF NOT EXISTS public.inbox_entries_default PARTITION OF public.inbox_entries DEFAULT;
CREATE TABLE IF NOT EXISTS public.chat_messages_default PARTITION OF public.chat_messages DEFAULT;
