// The most important regression guard for this PR's incident: assert the DB
// CHECK constraint inbox_entries_event_type_check admits EXACTLY the canonical
// app list INBOX_EVENT_TYPES (@srtdio/schemas), no more and no less.
//
// The bug was app<->DB drift: comment_batch_create / post_ready_notify emitted
// 'checkpoints_added' / 'post_ready', which the constraint rejected, rolling back
// the whole transaction. This test reads the constraint the local ephemeral stack
// built FROM the migrations (migration 20260717120000 widens it) and diffs its
// value set against the canonical list. If either side ever adds a value the other
// lacks, this goes red instead of failing silently in production.
//
// Reads the constraint with psql (the same tool the suite bring-up uses), so it
// needs the COMMENTS_SUITE stack up. Under the root config it auto-skips.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadRlsEnv } from '../../packages/test-utils/rls';
import { INBOX_EVENT_TYPES } from '../../packages/schemas/src/zod/inbox_entries';

const COMMENTS_SUITE = process.env.COMMENTS_SUITE === '1';

/** The value set the live CHECK constraint on public.inbox_entries admits. */
function readConstraintValues(dbUrl: string): string[] {
  const sql =
    'SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c ' +
    "WHERE c.conname = 'inbox_entries_event_type_check' " +
    "AND c.conrelid = 'public.inbox_entries'::regclass;";
  const def = execFileSync('psql', [dbUrl, '-At', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  // pg_get_constraintdef renders e.g.
  //   CHECK ((event_type = ANY (ARRAY['comment'::text, 'mention'::text, ...])))
  // The only single-quoted tokens are the array values.
  const values = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  if (values.length === 0) {
    throw new Error(`could not parse constraint values from: ${def || '<empty>'}`);
  }
  return values;
}

describe.runIf(COMMENTS_SUITE)('inbox_entries_event_type_check <-> INBOX_EVENT_TYPES', () => {
  it('the DB constraint admits exactly the canonical app list', () => {
    const dbValues = readConstraintValues(loadRlsEnv().dbUrl);
    const dbSet = new Set(dbValues);
    const appSet = new Set<string>(INBOX_EVENT_TYPES);

    // Precise, actionable failure messages: which side is missing what.
    const missingFromDb = [...appSet].filter((v) => !dbSet.has(v));
    const missingFromApp = [...dbSet].filter((v) => !appSet.has(v));
    expect(missingFromDb, 'canonical values the DB constraint rejects').toEqual([]);
    expect(missingFromApp, 'DB constraint values the app list is missing').toEqual([]);

    // No duplicates in the constraint, and the sets are identical.
    expect(dbValues.length).toBe(dbSet.size);
    expect([...dbSet].sort()).toEqual([...appSet].sort());
  });
});
