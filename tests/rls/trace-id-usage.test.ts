// Guard: every public function that accepts p_trace_id must use it.
// Seven group/DM actions once accepted p_trace_id and ignored it, so their
// changes never reached audit_log (fixed in 20260930150000_group_actions_audit_log.sql).
// This reads pg_proc on the migrated local database and fails, naming each
// offender, when a public function has p_trace_id among its arguments but its
// body (prosrc, which excludes the signature) never references it.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadRlsEnv } from '../../packages/test-utils/rls';

const RLS_SUITE = process.env.RLS_SUITE === '1';

// Functions allowed to accept p_trace_id without using it. Keep this list short
// and give every entry a reason.
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Server sync bookkeeping: the chat-agora-sync Worker stamps last_synced_at
  // and the Agora group id. EXECUTE is service_role only; it is not a person's
  // action, so there is nothing to audit.
  'chat_channel_mark_synced',
  'chat_thread_reply_counts', // Read-only STABLE invoker count: writes nothing, so nothing to log.
  // Read-only STABLE invoker search (20261003170000): writes nothing, so nothing to log.
  'chat_message_search',
  // Read-only STABLE invoker search (20261016204500): writes nothing, so nothing to log.
  'workspace_search_grouped',
  // Read-only STABLE invoker count (20261016213000): writes nothing, so nothing to log.
  'workspace_search_counts',
  // Read-only STABLE invoker list (20261004050000): writes nothing, so nothing to log.
  'chat_message_starred_list',
  // Read-only STABLE username check during onboarding (20261014140000): writes nothing.
  'username_available',
  // Read-only STABLE induction progress (20261015035000, definer since 20261015039000): writes nothing.
  'induction_state',
  // Read-only STABLE invoker reads (20261026120000_speedy_b): write nothing, so nothing to log.
  'activity_badge_read',
  'capabilities_for_workspace',
  'chat_open_bundle',
  'plan_bundle_read',
  'posts_list',
  'ref_resolve',
]);

/** Public functions whose arguments include p_trace_id but whose body never mentions it. */
function unusedTraceIdFunctions(dbUrl: string): string[] {
  const sql =
    'select distinct p.proname ' +
    'from pg_proc p join pg_namespace n on n.oid = p.pronamespace ' +
    "where n.nspname = 'public' " +
    "and 'p_trace_id' = any(p.proargnames) " +
    "and p.prosrc !~ '\\mp_trace_id\\M' " +
    'order by p.proname;';
  const out = execFileSync('psql', [dbUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Public functions whose arguments include p_trace_id (sanity: the query sees them). */
function traceIdFunctionCount(dbUrl: string): number {
  const sql =
    'select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace ' +
    "where n.nspname = 'public' and 'p_trace_id' = any(p.proargnames);";
  const out = execFileSync('psql', [dbUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  });
  return Number(out.trim());
}

describe.runIf(RLS_SUITE)('p_trace_id is used by every function that accepts it', () => {
  it('T7. no public function ignores p_trace_id outside the allowlist', () => {
    const { dbUrl } = loadRlsEnv();
    expect(traceIdFunctionCount(dbUrl)).toBeGreaterThan(0);
    const offenders = unusedTraceIdFunctions(dbUrl).filter((name) => !ALLOWLIST.has(name));
    expect(offenders, `functions ignoring p_trace_id: ${offenders.join(', ')}`).toEqual([]);
  });
});
