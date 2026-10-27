// Skew protection for open tabs (run in CI after `pnpm build`, before
// `wrangler pages deploy`, with Node's built-in TypeScript type stripping).
// Every Pages deploy replaces dist/, so the previous build's hashed
// /assets/* files disappear and a tab opened before the deploy fails its next
// lazy chunk load. This copies every asset the live site has served for less
// than RETAIN_DAYS back into dist/assets/, then writes dist/asset-history.json
// (every file now in dist/assets/ with the date it was first deployed) so the
// next deploy knows what to keep.
//
// SITE_URL (set per workflow step) is the live site to read from: production
// https://srtd.io, the test site for previews. A file that cannot be fetched
// is skipped with one log line; it never fails the deploy. A failure writing
// dist/ does.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETAIN_DAYS = 14;
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;
const CONCURRENCY = 8;
const HISTORY_FILE = 'asset-history.json';

interface HistoryEntry {
  path: string;
  firstSeen: string;
}

const dist = fileURLToPath(new URL('../dist', import.meta.url));

function log(message: string): void {
  process.stdout.write(`[carry-assets] ${message}\n`);
}

/** Only plain relative paths under assets/: never .., absolute or nested. */
function safeAssetPath(path: string): boolean {
  return /^assets\/[A-Za-z0-9._-]+$/.test(path) && !path.includes('..');
}

function parseHistory(raw: unknown): HistoryEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const files = (raw as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const entries: HistoryEntry[] = [];
  for (const file of files) {
    if (typeof file !== 'object' || file === null) continue;
    const { path, firstSeen } = file as { path?: unknown; firstSeen?: unknown };
    if (typeof path !== 'string' || typeof firstSeen !== 'string') continue;
    if (!safeAssetPath(path) || Number.isNaN(Date.parse(firstSeen))) continue;
    entries.push({ path, firstSeen });
  }
  return entries;
}

async function fetchHistory(site: string): Promise<HistoryEntry[]> {
  try {
    const res = await globalThis.fetch(`${site}/${HISTORY_FILE}`, { cache: 'no-store' });
    if (!res.ok) {
      log(`no history at ${site}/${HISTORY_FILE} (${res.status}); starting fresh`);
      return [];
    }
    return parseHistory(await res.json());
  } catch (err) {
    log(`history unreadable (${err instanceof Error ? err.message : String(err)}); starting fresh`);
    return [];
  }
}

/** The file's bytes, or null when it is gone (the SPA fallback answers HTML). */
async function download(site: string, path: string): Promise<Uint8Array | null> {
  try {
    const res = await globalThis.fetch(`${site}/${path}`, { cache: 'no-store' });
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || type.includes('text/html')) {
      log(`skip ${path}: ${res.status} ${type}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    log(`skip ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Run `task` over `items`, at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const site = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
  if (site === '') throw new Error('SITE_URL is not set');
  const assetsDir = join(dist, 'assets');
  if (!existsSync(assetsDir)) throw new Error(`${assetsDir} is missing; run pnpm build first`);

  const now = Date.now();
  const history = await fetchHistory(site);
  const firstSeen = new Map<string, string>();
  for (const entry of history) {
    const prior = firstSeen.get(entry.path);
    if (prior === undefined || Date.parse(entry.firstSeen) < Date.parse(prior)) {
      firstSeen.set(entry.path, entry.firstSeen);
    }
  }

  const toCarry = [...firstSeen.entries()]
    .filter(([path, seen]) => now - Date.parse(seen) < RETAIN_MS && !existsSync(join(dist, path)))
    .map(([path]) => path);

  let carried = 0;
  await eachLimited(toCarry, CONCURRENCY, async (path) => {
    const bytes = await download(site, path);
    if (bytes === null) return;
    // A write failure throws out of main and fails the deploy.
    const target = join(dist, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    carried += 1;
  });

  const stamp = new Date(now).toISOString();
  const files: HistoryEntry[] = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = `assets/${entry.name}`;
      return { path, firstSeen: firstSeen.get(path) ?? stamp };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(join(dist, HISTORY_FILE), `${JSON.stringify({ files }, null, 2)}\n`);
  log(`carried ${carried}/${toCarry.length} old assets; history lists ${files.length} files`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[carry-assets] failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
