// Vitest globalSetup for the RLS suite. Brings up a local, ephemeral Supabase
// container via the project's Supabase CLI, applies every file in
// supabase/migrations/ (the CLI does this on `start`), and hands the connection
// details to the test workers through a temp JSON file. Nothing here touches the
// live database.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { rlsEnvFile, type RlsEnv } from '../../packages/test-utils/rls';
import { SUPABASE_EXCLUDE } from '../../packages/test-utils/supabase-exclude';

// Non-essential containers excluded: they are unused by RLS tests and some
// cannot start under a restricted sandbox (edge-runtime rlimits).
const EXCLUDE = SUPABASE_EXCLUDE;

const supabaseBin = resolve(process.cwd(), 'node_modules/.bin/supabase');

function supabase(args: string[]): string {
  return execFileSync(supabaseBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isRunning(): boolean {
  try {
    supabase(['status']);
    return true;
  } catch {
    return false;
  }
}

function parseEnv(envOutput: string): RlsEnv {
  const pick = (key: string): string => {
    const match = envOutput.match(new RegExp(`^${key}="?([^"\\n]+)"?$`, 'm'));
    if (!match?.[1]) throw new Error(`could not read ${key} from supabase status`);
    return match[1];
  };
  return {
    url: pick('API_URL'),
    anonKey: pick('ANON_KEY'),
    serviceKey: pick('SERVICE_ROLE_KEY'),
    dbUrl: pick('DB_URL'),
  };
}

// Whether this process started the stack (and so must stop it on teardown).
let startedHere = false;

/** One timing line for CI logs; stdout, not console. */
function logTiming(label: string, since: number): void {
  process.stdout.write(`[setup] ${label} ${((performance.now() - since) / 1000).toFixed(1)}s\n`);
}

/** The CLI's registry override (viper INTERNAL_IMAGE_REGISTRY, SUPABASE_ env prefix). */
const REGISTRY_ENV = 'SUPABASE_INTERNAL_IMAGE_REGISTRY';

/** Fallback registry when the default (public.ecr.aws) refuses anonymous pulls. */
const FALLBACK_REGISTRY = 'docker.io';

/** The CLI's stderr from a failed execFileSync, or '' when there is none. */
function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

/**
 * public.ecr.aws caps anonymous pulls per source IP, and GitHub-hosted runners
 * share IPs, so a start can fail with "toomanyrequests: Data limit exceeded"
 * before any test runs. That is a registry limit, not a test failure.
 */
export function isPullRateLimited(stderr: string): boolean {
  return /toomanyrequests|data limit exceeded|rate limit/i.test(stderr);
}

function stopQuietly(): void {
  try {
    supabase(['stop', '--no-backup']);
  } catch {
    // Best effort: nothing to stop, or already gone.
  }
}

function pause(ms: number): void {
  // Synchronous pause, matching this file's blocking execFileSync style.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `supabase start` has an intra-start Docker race: if the db container fails its
// first health check the CLI recreates it, but the old docker-proxy holding the
// published port may not have released it yet, so the rebind collides with
// "port 54322 already in use". Re-running clears it. This wraps the single start
// with one self-healing retry: stop (best effort), pause, then start once more.
// When the first start failed because the image registry refused the pull, the
// retry pulls the same images from Docker Hub instead (set on process.env so
// every later CLI call in this process agrees on the registry).
function startWithRetry(): void {
  try {
    supabase(['start', '-x', EXCLUDE]);
    return;
  } catch (error) {
    // Attempt 1 failed; tear down whatever came up so the port is released.
    stopQuietly();
    if (isPullRateLimited(stderrOf(error)) && process.env[REGISTRY_ENV] === undefined) {
      process.env[REGISTRY_ENV] = FALLBACK_REGISTRY;
    }
    // ~3s to let docker-proxy release the published port.
    pause(3000);
    // Attempt 2: if this throws, it propagates to the caller.
    supabase(['start', '-x', EXCLUDE]);
  }
}

export async function setup(): Promise<void> {
  const setupAt = performance.now();
  // `supabase start` needs a config; create one on the fly if absent. The
  // generated config is local-only dev infra and is intentionally not committed.
  if (!existsSync(resolve(process.cwd(), 'supabase/config.toml'))) {
    try {
      supabase(['init']);
    } catch {
      // Already initialized or partially present; start will validate.
    }
  }

  if (!isRunning()) {
    const startAt = performance.now();
    process.stdout.write('[setup] supabase start begin\n');
    startWithRetry();
    logTiming('supabase start', startAt);
    startedHere = true;
  }

  const env = parseEnv(supabase(['status', '-o', 'env']));
  writeFileSync(rlsEnvFile, JSON.stringify(env), 'utf8');
  // `supabase start` applies supabase/migrations/, so this is post-migrations.
  logTiming('total', setupAt);
}

export async function teardown(): Promise<void> {
  if (startedHere) {
    try {
      supabase(['stop']);
    } catch {
      // Best effort: the container is ephemeral and reclaimed with the runner.
    }
  }
  try {
    rmSync(rlsEnvFile, { force: true });
  } catch {
    // ignore
  }
}
