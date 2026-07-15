// Env + CLI parsing and the hard safety guards for the v1 -> v2 ETL. Everything
// the run needs is read from process.env here (never hardcoded) and validated
// once at startup, so a misconfigured run aborts immediately with a clear
// message instead of failing part-way through a load. The guards are pure and
// unit-tested: same-database refusal, target project-ref pinning, and the
// cutover confirmation flag all live here.

type Mode = 'dev-seed' | 'cutover';

export interface Cli {
  mode: Mode;
  dryRun: boolean;
  confirmCutover: boolean;
  // Cutover-rehearsal flags. Optional so older EtlConfig literals (e.g. the load
  // suite fixtures) keep type-checking; parseCli always returns concrete booleans.
  wipe?: boolean;
  confirmWipe?: boolean;
  validate?: boolean;
}

export interface EtlConfig {
  sourceUrl: string;
  targetUrl: string;
  expectedTargetRef: string;
  operatorUserId: string;
  operatorEmail: string;
  operatorDisplayName: string;
  workspaceName: string;
  workspaceTimezone: string;
  cli: Cli;
}

// dev-seed vs cutover discriminator. The single source of truth for this check,
// imported by both load.ts (PII scrubbing) and assets.ts (no-bytes asset rows).
export function isDevSeed(config: EtlConfig): boolean {
  return config.cli.mode === 'dev-seed';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// Parse the launch flags. cutover is a launch flag only (--confirm-cutover); the
// script never prompts interactively. Unknown flags abort rather than silently
// no-op so a typo in a launch command can never weaken a guard.
export function parseCli(argv: readonly string[]): Cli {
  let mode: Mode = 'dev-seed';
  let dryRun = false;
  let confirmCutover = false;
  let wipe = false;
  let confirmWipe = false;
  let validate = false;
  for (const arg of argv) {
    if (arg === '--') {
      // Bare separator (e.g. inserted by `pnpm run etl -- ...`); ignore it.
      continue;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--confirm-cutover') {
      confirmCutover = true;
    } else if (arg === '--wipe') {
      wipe = true;
    } else if (arg === '--confirm-wipe') {
      confirmWipe = true;
    } else if (arg === '--validate') {
      validate = true;
    } else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value !== 'dev-seed' && value !== 'cutover') {
        throw new Error(`Invalid --mode='${value}'. Expected 'dev-seed' or 'cutover'.`);
      }
      mode = value;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }
  return { mode, dryRun, confirmCutover, wipe, confirmWipe, validate };
}

// Read and validate every required variable. Missing ones are collected and
// reported together so a single run fixes the whole set.
export function loadConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): EtlConfig {
  const cli = parseCli(argv);
  const missing: string[] = [];
  const get = (name: string): string => {
    const raw = env[name];
    const value = raw === undefined ? '' : raw.trim();
    if (value === '') {
      missing.push(name);
      return '';
    }
    return value;
  };

  const sourceUrl = get('SOURCE_DATABASE_URL');
  const targetUrl = get('TARGET_DATABASE_URL');
  const expectedTargetRef = get('EXPECTED_TARGET_REF');
  const operatorUserId = get('OPERATOR_USER_ID');
  const operatorEmail = get('OPERATOR_EMAIL');
  const operatorDisplayName = get('OPERATOR_DISPLAY_NAME');
  const workspaceName = get('TARGET_WORKSPACE_NAME');
  const tz = env.TARGET_WORKSPACE_TIMEZONE;
  const workspaceTimezone = tz !== undefined && tz.trim() !== '' ? tz.trim() : DEFAULT_TIMEZONE;

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}.`);
  }
  if (!UUID_RE.test(operatorUserId)) {
    throw new Error(`OPERATOR_USER_ID must be a uuid; got '${operatorUserId}'.`);
  }

  return {
    sourceUrl,
    targetUrl,
    expectedTargetRef,
    operatorUserId,
    operatorEmail,
    operatorDisplayName,
    workspaceName,
    workspaceTimezone,
    cli,
  };
}

export interface ConnectionTarget {
  host: string;
  port: string;
  database: string;
}

// Normalise a connection string to the (host, port, database) it resolves to,
// for the same-database guard. Defaults match libpq (port 5432, db postgres).
export function describeConnection(url: string): ConnectionTarget {
  const u = new URL(url);
  return {
    host: u.hostname.toLowerCase(),
    port: u.port !== '' ? u.port : '5432',
    database: u.pathname.replace(/^\//, '') !== '' ? u.pathname.replace(/^\//, '') : 'postgres',
  };
}

// True when SOURCE and TARGET point at the same physical database. Writing to
// v1 is never allowed, so an accidental same-url config must abort.
//
// When both URLs carry a Supabase project ref, the ref is the only reliable
// discriminator: two distinct projects in one region share host/port/database
// behind the session pooler (aws-1-<region>.pooler.supabase.com:5432/postgres),
// so a host/port/database tuple match there is a false positive. Compare refs
// instead. When either ref is unreadable (non-Supabase or direct URL the parser
// cannot read), fall back to the host/port/database tuple so the guard is never
// weakened.
export function sameDatabase(sourceUrl: string, targetUrl: string): boolean {
  const refA = extractProjectRef(sourceUrl);
  const refB = extractProjectRef(targetUrl);
  if (refA !== null && refB !== null) {
    return refA === refB;
  }
  const a = describeConnection(sourceUrl);
  const b = describeConnection(targetUrl);
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

// Pull the Supabase project ref out of a connection string. It appears either in
// the host (db.<ref>.supabase.co) or, for the pooler, in the user
// (postgres.<ref>@...pooler...). Returns null when neither form is present.
export function extractProjectRef(url: string): string | null {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const hostMatch = host.match(/^(?:db|api)\.([a-z0-9]{16,})\.supabase\.(?:co|com|net)$/);
  if (hostMatch) return hostMatch[1] ?? null;
  const user = decodeURIComponent(u.username);
  const userMatch = user.match(/^postgres\.([a-z0-9]{16,})$/);
  if (userMatch) return userMatch[1] ?? null;
  return null;
}

// True only when the TARGET connection string resolves to the expected ref.
export function targetRefMatches(targetUrl: string, expectedRef: string): boolean {
  return extractProjectRef(targetUrl) === expectedRef;
}

// All hard aborts in one place. Called after loadConfig, before any connection
// in a non-dry-run path and before any read in a dry-run path.
export function assertSafe(config: EtlConfig): void {
  if (sameDatabase(config.sourceUrl, config.targetUrl)) {
    throw new Error(
      'Refusing to run: SOURCE_DATABASE_URL and TARGET_DATABASE_URL resolve to the same database.',
    );
  }
  if (!targetRefMatches(config.targetUrl, config.expectedTargetRef)) {
    throw new Error(
      `Refusing to run: TARGET_DATABASE_URL does not point at EXPECTED_TARGET_REF='${config.expectedTargetRef}'.`,
    );
  }
  // A wipe is destructive, so it is double-gated. The sameDatabase and
  // targetRefMatches guards above already pinned it to EXPECTED_TARGET_REF and
  // kept it off v1; this requires an explicit --confirm-wipe on top.
  if (config.cli.wipe && !config.cli.confirmWipe) {
    throw new Error('Refusing to wipe: pass --confirm-wipe to proceed.');
  }
  // The confirm-cutover gate applies ONLY to an actual cutover load. A validate
  // pass (read-only) and a wipe never load, so neither requires --confirm-cutover.
  // The same-database refusal and target-ref pinning above stay in force for all.
  if (
    config.cli.mode === 'cutover' &&
    !config.cli.validate &&
    !config.cli.wipe &&
    !config.cli.confirmCutover
  ) {
    throw new Error('Refusing to run cutover mode: pass --confirm-cutover to proceed.');
  }
}
