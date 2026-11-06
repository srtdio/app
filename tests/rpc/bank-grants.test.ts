// Idea bank grants (20261106110000_plan_bank_notify.sql, end of file):
// 20261106010000_plan_bank.sql revoked EXECUTE on the seven bank procs from
// PUBLIC and anon without granting it back to authenticated, so every bank
// write returned 403 until the grants landed out of band on 6 Nov 2026. This
// spec reads the privileges on the local stack, so a future revoke without a
// grant back fails CI.

import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadRlsEnv } from '../../packages/test-utils/rls';

const RPC_SUITE = process.env.RPC_SUITE === '1';

/** The seven bank write procs, by their identity signatures. */
const BANK_PROCS = [
  'public.bank_idea_create(uuid, text, text, uuid[], uuid[], uuid)',
  'public.plan_item_to_bank(uuid, uuid)',
  'public.plan_item_from_bank(uuid, uuid, date, uuid)',
  'public.bank_idea_set(uuid, boolean, boolean, boolean, uuid)',
  'public.plan_item_buckets_set(uuid, uuid[], uuid)',
  'public.workspace_bucket_rename(uuid, text, uuid)',
  'public.workspace_bucket_delete(uuid, uuid)',
] as const;

describe.runIf(RPC_SUITE)('idea bank procs: EXECUTE for authenticated, never anon', () => {
  let dbUrl: string;

  beforeAll(() => {
    dbUrl = loadRlsEnv().dbUrl;
  });

  /** Runs SQL as postgres on the local stack; returns the trimmed -At output. */
  function psql(sql: string): string {
    return execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
      encoding: 'utf8',
    }).trim();
  }

  it.each(BANK_PROCS)('%s: authenticated may execute, anon may not', (proc) => {
    expect(psql(`select has_function_privilege('authenticated', '${proc}', 'EXECUTE')::text`)).toBe(
      'true',
    );
    expect(psql(`select has_function_privilege('anon', '${proc}', 'EXECUTE')::text`)).toBe('false');
  });

  it('bank_live_can_receive: authenticated only (20261106120000_bank_live_ping)', () => {
    const fn = 'public.bank_live_can_receive(uuid)';
    expect(psql(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE')::text`)).toBe(
      'true',
    );
    expect(psql(`select has_function_privilege('anon', '${fn}', 'EXECUTE')::text`)).toBe('false');
  });
});
