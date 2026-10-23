// Vitest globalSetup for the auth E2E suite. Brings up the local, ephemeral
// Supabase stack via the project's Supabase CLI and hands the connection details
// (plus the JWT secret, needed to mint a deliberately-expired token) to the test
// workers through a temp JSON file. Nothing here touches the live database.
//
// Unlike the RLS suite we KEEP the mail container running: magic-link and
// recovery signup send email through it, and GoTrue errors if the SMTP target
// is down.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authEnvFile, type AuthTestEnv } from './env';
import { SUPABASE_EXCLUDE_WITH_MAIL } from '../../packages/test-utils/supabase-exclude';

// Heavy/unstartable containers excluded; the mail catcher is intentionally kept.
const EXCLUDE = SUPABASE_EXCLUDE_WITH_MAIL;

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

function parseEnv(envOutput: string): AuthTestEnv {
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
    jwtSecret: pick('JWT_SECRET'),
  };
}

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
 * before any test runs. Same check as tests/rls/setup.ts.
 */
function isPullRateLimited(stderr: string): boolean {
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

// One self-healing retry around `supabase start`, mirroring tests/rls/setup.ts:
// stop (best effort), pause so docker-proxy releases the port, start again. When
// the first start failed because the registry refused the pull, the retry pulls
// the same images from Docker Hub (set on process.env so every later CLI call in
// this process agrees on the registry).
function startWithRetry(): void {
  try {
    supabase(['start', '-x', EXCLUDE]);
    return;
  } catch (error) {
    stopQuietly();
    if (isPullRateLimited(stderrOf(error)) && process.env[REGISTRY_ENV] === undefined) {
      process.env[REGISTRY_ENV] = FALLBACK_REGISTRY;
    }
    pause(3000);
    supabase(['start', '-x', EXCLUDE]);
  }
}

// Raise the built-in email send rate limit before the stack boots. The CLI
// default is intentionally tiny (a couple per hour) to discourage prod use; the
// signup and password-reset flows each send one, so we lift the ceiling to keep
// the suite re-runnable against a long-lived container.
function relaxEmailRateLimit(): void {
  const configPath = resolve(process.cwd(), 'supabase/config.toml');
  if (!existsSync(configPath)) return;
  const config = readFileSync(configPath, 'utf8');
  if (!/email_sent\s*=\s*\d+/.test(config)) return;
  const patched = config.replace(/email_sent\s*=\s*\d+/, 'email_sent = 1000');
  if (patched !== config) writeFileSync(configPath, patched, 'utf8');
}

export async function setup(): Promise<void> {
  const setupAt = performance.now();
  if (!existsSync(resolve(process.cwd(), 'supabase/config.toml'))) {
    try {
      supabase(['init']);
    } catch {
      // Already initialized or partially present; start will validate.
    }
  }

  relaxEmailRateLimit();

  if (!isRunning()) {
    const startAt = performance.now();
    process.stdout.write('[setup] supabase start begin\n');
    startWithRetry();
    logTiming('supabase start', startAt);
    startedHere = true;
  }

  const env = parseEnv(supabase(['status', '-o', 'env']));
  writeFileSync(authEnvFile, JSON.stringify(env), 'utf8');
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
    rmSync(authEnvFile, { force: true });
  } catch {
    // ignore
  }
}
