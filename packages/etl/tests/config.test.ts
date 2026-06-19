import { describe, it, expect } from 'vitest';
import { sameDatabase, assertSafe, loadConfig, type EtlConfig } from '../src/config.ts';

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

// Regression: a secret pasted with a trailing newline or surrounding whitespace
// (common from copy-paste) must not fail validation. loadConfig's get() trims on
// read, so OPERATOR_USER_ID survives UUID validation and every required var comes
// back clean.
const VALID_UUID = 'c92a4e1b-e212-4bdd-8636-283ebbe427a5';
const validEnv = (): Record<string, string | undefined> => ({
  SOURCE_DATABASE_URL: poolerUrl(REF_A),
  TARGET_DATABASE_URL: poolerUrl(REF_B),
  EXPECTED_TARGET_REF: REF_B,
  OPERATOR_USER_ID: VALID_UUID,
  OPERATOR_EMAIL: 'op@example.com',
  OPERATOR_DISPLAY_NAME: 'Op',
  TARGET_WORKSPACE_NAME: 'WS',
});

describe('loadConfig whitespace trimming', () => {
  it('trims surrounding whitespace and a trailing newline before UUID validation', () => {
    const env = validEnv();
    env.OPERATOR_USER_ID = `  ${VALID_UUID}\n`;
    let config: EtlConfig | undefined;
    expect(() => {
      config = loadConfig(env, []);
    }).not.toThrow();
    expect(config?.operatorUserId).toBe(VALID_UUID);
    expect(config?.operatorUserId).toHaveLength(36);
  });

  it('trims surrounding whitespace on a required string var', () => {
    const env = validEnv();
    env.TARGET_WORKSPACE_NAME = '  Acme Co  \n';
    const config = loadConfig(env, []);
    expect(config.workspaceName).toBe('Acme Co');
  });
});

describe('assertSafe same-database guard', () => {
  it('does not throw for two different same-region pooler projects', () => {
    expect(() => assertSafe(configFor(poolerUrl(REF_A), poolerUrl(REF_B), REF_B))).not.toThrow();
  });

  it('throws when source and target pooler URLs share a ref', () => {
    expect(() => assertSafe(configFor(poolerUrl(REF_A), poolerUrl(REF_A), REF_A))).toThrow(
      /same database/i,
    );
  });
});
