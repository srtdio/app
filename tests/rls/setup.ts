// Vitest globalSetup for the RLS suite. Brings up a local, ephemeral Supabase
// container via the project's Supabase CLI, applies every file in
// supabase/migrations/ (the CLI does this on `start`), and hands the connection
// details to the test workers through a temp JSON file. Nothing here touches the
// live database.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { rlsEnvFile, type RlsEnv } from '../../packages/test-utils/rls';

// Non-essential containers excluded: they are unused by RLS tests and some
// cannot start under a restricted sandbox (edge-runtime rlimits).
const EXCLUDE = [
  'edge-runtime',
  'studio',
  'imgproxy',
  'storage-api',
  'realtime',
  'vector',
  'logflare',
  'supavisor',
  'mailpit',
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

export async function setup(): Promise<void> {
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
    supabase(['start', '-x', EXCLUDE]);
    startedHere = true;
  }

  const env = parseEnv(supabase(['status', '-o', 'env']));
  writeFileSync(rlsEnvFile, JSON.stringify(env), 'utf8');
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
