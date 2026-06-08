import { describe, it, expect } from 'vitest';
import { sameDatabase, assertSafe, type EtlConfig } from '../src/config.ts';

// Regression tests for the same-database safety guard. The bug: two distinct
// Supabase projects in one region share host/port/database behind the session
// pooler, so sameDatabase() falsely reported them as identical and assertSafe()
// wrongly aborted. The guard must distinguish projects by ref while still
// blocking a genuine source==target config.

const REF_A = 'aaaaaaaaaaaaaaaa';
const REF_B = 'bbbbbbbbbbbbbbbb';
const POOLER = 'aws-1-ap-south-1.pooler.supabase.com';

const poolerUrl = (ref: string): string =>
  `postgresql://postgres.${ref}:pw@${POOLER}:5432/postgres`;
const directUrl = (ref: string): string =>
  `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;

// Minimal config whose only failing guard would be sameDatabase: target ref is
// pinned correctly and mode is dev-seed so the cutover guard is inert.
const configFor = (sourceUrl: string, targetUrl: string, expectedTargetRef: string): EtlConfig => ({
  sourceUrl,
  targetUrl,
  expectedTargetRef,
  operatorUserId: '00000000-0000-0000-0000-000000000000',
  operatorEmail: 'op@example.com',
  operatorDisplayName: 'Op',
  workspaceName: 'WS',
  workspaceTimezone: 'Asia/Kolkata',
  cli: { mode: 'dev-seed', dryRun: true, confirmCutover: false },
});

describe('sameDatabase', () => {
  it('returns false for two same-region pooler URLs with different refs', () => {
    expect(sameDatabase(poolerUrl(REF_A), poolerUrl(REF_B))).toBe(false);
  });

  it('returns true for two pooler URLs with the same ref', () => {
    expect(sameDatabase(poolerUrl(REF_A), poolerUrl(REF_A))).toBe(true);
  });

  it('returns true for identical full URLs (original guard regression)', () => {
    const url = poolerUrl(REF_A);
    expect(sameDatabase(url, url)).toBe(true);
  });

  it('returns false for two direct-connection URLs with different refs', () => {
    expect(sameDatabase(directUrl(REF_A), directUrl(REF_B))).toBe(false);
  });

  it('falls back to host/port/database when a ref is unreadable', () => {
    const noRef = 'postgresql://user:pw@db.internal.example.com:5432/postgres';
    const other = 'postgresql://user:pw@db.internal.example.com:5432/postgres';
    const different = 'postgresql://user:pw@other.example.com:5432/postgres';
    expect(sameDatabase(poolerUrl(REF_A), noRef)).toBe(false);
    expect(sameDatabase(noRef, other)).toBe(true);
    expect(sameDatabase(noRef, different)).toBe(false);
  });
});

describe('assertSafe same-database guard', () => {
  it('does not throw for two different same-region pooler projects', () => {
    expect(() =>
      assertSafe(configFor(poolerUrl(REF_A), poolerUrl(REF_B), REF_B)),
    ).not.toThrow();
  });

  it('throws when source and target pooler URLs share a ref', () => {
    expect(() =>
      assertSafe(configFor(poolerUrl(REF_A), poolerUrl(REF_A), REF_A)),
    ).toThrow(/same database/i);
  });
});
