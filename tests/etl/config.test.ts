// Pure coverage for the safety guards and CLI parsing in config.ts. These are
// critical-surface: a weakened guard could write to v1 or the wrong v2 project.
// No database.

import { describe, expect, it } from 'vitest';

import {
  assertSafe,
  describeConnection,
  extractProjectRef,
  loadConfig,
  parseCli,
  sameDatabase,
  targetRefMatches,
  type EtlConfig,
} from '../../packages/etl/src/config';

const REF = 'movnexawfhsyuluspxoc';
const SOURCE = 'postgresql://postgres:pw@db.ozptjplxbyswclolbxyn.supabase.co:5432/postgres';
const TARGET = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
const POOLER_TARGET = `postgresql://postgres.${REF}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`;

function baseEnv(): Record<string, string | undefined> {
  return {
    SOURCE_DATABASE_URL: SOURCE,
    TARGET_DATABASE_URL: TARGET,
    EXPECTED_TARGET_REF: REF,
    OPERATOR_USER_ID: '0190a000-0000-7000-8000-000000000000',
    OPERATOR_EMAIL: 'ops@example.com',
    OPERATOR_DISPLAY_NAME: 'Ops',
    TARGET_WORKSPACE_NAME: 'Acme',
  };
}

describe('parseCli', () => {
  it('defaults to dev-seed, no dry-run, no confirm', () => {
    expect(parseCli([])).toEqual({ mode: 'dev-seed', dryRun: false, confirmCutover: false });
  });
  it('parses the flags', () => {
    expect(parseCli(['--mode=cutover', '--dry-run', '--confirm-cutover'])).toEqual({
      mode: 'cutover',
      dryRun: true,
      confirmCutover: true,
    });
  });
  it('rejects an invalid mode', () => {
    expect(() => parseCli(['--mode=wipe'])).toThrow(/Invalid --mode/);
  });
  it('rejects unknown args', () => {
    expect(() => parseCli(['--yolo'])).toThrow(/Unknown argument/);
  });
});

describe('loadConfig', () => {
  it('loads a complete env and defaults the timezone', () => {
    const config = loadConfig(baseEnv(), []);
    expect(config.expectedTargetRef).toBe(REF);
    expect(config.workspaceTimezone).toBe('Asia/Kolkata');
  });
  it('honours an explicit timezone', () => {
    const config = loadConfig({ ...baseEnv(), TARGET_WORKSPACE_TIMEZONE: 'UTC' }, []);
    expect(config.workspaceTimezone).toBe('UTC');
  });
  it('reports all missing required variables together', () => {
    const env = baseEnv();
    delete env.TARGET_DATABASE_URL;
    delete env.OPERATOR_EMAIL;
    expect(() => loadConfig(env, [])).toThrow(/TARGET_DATABASE_URL.*OPERATOR_EMAIL|OPERATOR_EMAIL/);
  });
  it('rejects a non-uuid operator id', () => {
    expect(() => loadConfig({ ...baseEnv(), OPERATOR_USER_ID: 'nope' }, [])).toThrow(/uuid/);
  });
});

describe('describeConnection', () => {
  it('extracts host, port, database with libpq defaults', () => {
    expect(describeConnection('postgresql://u:p@host.example/')).toEqual({
      host: 'host.example',
      port: '5432',
      database: 'postgres',
    });
  });
});

describe('sameDatabase', () => {
  it('is false for distinct hosts', () => {
    expect(sameDatabase(SOURCE, TARGET)).toBe(false);
  });
  it('is true when source and target resolve identically', () => {
    expect(sameDatabase(TARGET, TARGET)).toBe(true);
  });
});

describe('extractProjectRef / targetRefMatches', () => {
  it('reads the ref from the db host form', () => {
    expect(extractProjectRef(TARGET)).toBe(REF);
  });
  it('reads the ref from the pooler user form', () => {
    expect(extractProjectRef(POOLER_TARGET)).toBe(REF);
  });
  it('returns null for a non-supabase host', () => {
    expect(extractProjectRef('postgresql://u:p@localhost:5432/postgres')).toBeNull();
  });
  it('matches only the expected ref', () => {
    expect(targetRefMatches(TARGET, REF)).toBe(true);
    expect(targetRefMatches(SOURCE, REF)).toBe(false);
  });
});

describe('assertSafe', () => {
  const base: EtlConfig = loadConfig(baseEnv(), []);

  it('passes for a well-formed dev-seed config', () => {
    expect(() => assertSafe(base)).not.toThrow();
  });
  it('aborts when source and target are the same database', () => {
    expect(() => assertSafe({ ...base, sourceUrl: TARGET })).toThrow(/same database/);
  });
  it('aborts when the target ref does not match', () => {
    expect(() => assertSafe({ ...base, expectedTargetRef: 'other000000000000000' })).toThrow(
      /EXPECTED_TARGET_REF/,
    );
  });
  it('aborts cutover without --confirm-cutover', () => {
    const cutover: EtlConfig = {
      ...base,
      cli: { mode: 'cutover', dryRun: false, confirmCutover: false },
    };
    expect(() => assertSafe(cutover)).toThrow(/--confirm-cutover/);
  });
  it('allows cutover with --confirm-cutover', () => {
    const cutover: EtlConfig = {
      ...base,
      cli: { mode: 'cutover', dryRun: false, confirmCutover: true },
    };
    expect(() => assertSafe(cutover)).not.toThrow();
  });
});
