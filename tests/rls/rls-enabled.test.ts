// Every relation in the public schema must have row-level security enabled.
// We read pg_class.relrowsecurity directly (catalogs are not exposed over
// PostgREST) via psql against the local container's connection string.
//
// Expected: 45 relations = 33 base tables + 3 partition parents + 9 partition
// children, all with RLS on.

import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadRlsEnv } from '../../packages/test-utils/rls';

const RLS_SUITE = process.env.RLS_SUITE === '1';

const EXPECTED_RELATION_COUNT = 45;

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

  it('covers exactly 45 relations (33 base + 3 parents + 9 children)', () => {
    expect(relations).toHaveLength(EXPECTED_RELATION_COUNT);
  });

  it('has relrowsecurity = true for every relation', () => {
    const without = relations.filter((r) => !r.rls).map((r) => r.relname);
    expect(without).toEqual([]);
  });
});
