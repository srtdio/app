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

// Heavy/unstartable containers excluded; the mail catcher is intentionally kept.
const EXCLUDE = [
  'edge-runtime',
  'studio',
  'imgproxy',
  'storage-api',
  'realtime',
  'vector',
  'logflare',
  'supavisor',
  'postgres-meta',
].join(',');

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
  if (!existsSync(resolve(process.cwd(), 'supabase/config.toml'))) {
    try {
      supabase(['init']);
    } catch {
      // Already initialized or partially present; start will validate.
    }
  }

  relaxEmailRateLimit();

  if (!isRunning()) {
    supabase(['start', '-x', EXCLUDE]);
    startedHere = true;
  }

  const env = parseEnv(supabase(['status', '-o', 'env']));
  writeFileSync(authEnvFile, JSON.stringify(env), 'utf8');
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
