// Every relation in the public schema must have row-level security enabled.
// We read pg_class.relrowsecurity directly (catalogs are not exposed over
// PostgREST) via psql against the local container's connection string.
//
// Expected: 149 relations = 47 base tables + 3 partition parents + 99 partition
// children, all with RLS on.

import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadRlsEnv } from '../../packages/test-utils/rls';

const RLS_SUITE = process.env.RLS_SUITE === '1';

// Bumped 45 -> 46 for public.workspace_counters, then 46 -> 47 for
// public.post_ready_notifications (each added with RLS enabled in its migration).
// Then 47 -> 137 when audit_log, inbox_entries and chat_messages were each given
// monthly partitions for 2026-08..2028-12 plus a DEFAULT: 3 tables x (29 months
// + 1 default) = 90 new children on top of the 9 the baseline creates. Partitions
// come up with relrowsecurity copied from their parent, so the second assertion
// below covers them without any per-partition ALTER. Then 137 -> 140 for the
// chat record tables chat_reactions, chat_read_cursors and chat_sync_events
// (20260922200000_chat_postgres_record.sql, each created with RLS enabled).
// Then 140 -> 141 for chat_message_marks
// (20260927131500_chat_marks_delete_briefs.sql, created with RLS enabled).
// Then 141 -> 142 for chat_channel_clears
// (20260927200000_chat_forward_and_clear.sql, created with RLS enabled).
// Then 142 -> 143 for chat_scheduled_messages.
// Then 143 -> 144 for chat_message_reminders
// (20261003140000_chat_message_reminders.sql, created with RLS enabled).
// Then 144 -> 145 for chat_message_stars.
// Then 145 -> 148 for plans, plan_items and plan_item_reviews
// (20261009110000_plans_core.sql, each created with RLS enabled).
// Then 148 -> 149 for plan_item_comments (20261009205500_plan_item_comments.sql).
const EXPECTED_RELATION_COUNT = 149;

interface Relation {
  relname: string;
  rls: boolean;
}

const QUERY =
  "select coalesce(json_agg(json_build_object('relname', c.relname, 'rls', c.relrowsecurity) " +
  "order by c.relname), '[]') " +
  'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
  "where n.nspname = 'public' and c.relkind in ('r', 'p');";

describe.runIf(RLS_SUITE)('RLS is enabled on every public relation', () => {
  let relations: Relation[];

  beforeAll(() => {
    const dbUrl = loadRlsEnv().dbUrl;
    const out = execFileSync('psql', [dbUrl, '-At', '-c', QUERY], { encoding: 'utf8' });
    relations = JSON.parse(out.trim()) as Relation[];
  });

  it('covers exactly 149 relations (47 base + 3 parents + 99 children)', () => {
    expect(relations).toHaveLength(EXPECTED_RELATION_COUNT);
  });

  it('has relrowsecurity = true for every relation', () => {
    const without = relations.filter((r) => !r.rls).map((r) => r.relname);
    expect(without).toEqual([]);
  });
});
