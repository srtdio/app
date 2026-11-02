// Skew protection for open tabs (run in CI after `pnpm build`, before
// `wrangler pages deploy`, with Node's built-in TypeScript type stripping).
// Every Pages deploy replaces dist/, so the previous build's hashed
// /assets/* files disappear and a tab opened before the deploy fails its next
// lazy chunk load. This copies every asset the live site has served for less
// than RETAIN_DAYS back into dist/assets/, then writes dist/asset-history.json
// (every file now in dist/assets/ with the date it was first deployed) so the
// next deploy knows what to keep.
//
// Cloudflare Pages takes at most 20,000 files per deployment. Carried files
// are kept for RETAIN_DAYS (2: an older open tab recovers through the app's
// chunk-reload path, src/lib/chunk-reload.ts reloadIfStale), and a hard cap
// keeps the whole of dist/ at or under MAX_DIST_FILES: past it, carried files
// are dropped oldest-first (by their first deploy date). A file of the
// current build is never dropped.
//
// SITE_URL (set per workflow step) is the live site to read from: production
// https://srtd.io, the test site for previews. A file that cannot be fetched
// is skipped with one log line; it never fails the deploy. A failure writing
// dist/ does.

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETAIN_DAYS = 2;
/** The most files dist/ may hold after carrying (Pages' limit is 20,000). */
export const MAX_DIST_FILES = 19_000;
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;
const CONCURRENCY = 8;
const HISTORY_FILE = 'asset-history.json';

export interface HistoryEntry {
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

/**
 * The carried files to drop so dist/ holds at most `ceiling` files: the
 * oldest first deploys first (ties by path), never more than are carried.
 * `carried` lists only files copied from earlier deploys, so a file of the
 * current build can never be returned. Pure.
 */
export function filesToDrop(
  distFileCount: number,
  carried: readonly HistoryEntry[],
  ceiling: number = MAX_DIST_FILES,
): string[] {
  const excess = distFileCount - ceiling;
  if (excess <= 0) return [];
  return [...carried]
    .sort(
      (a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen) || a.path.localeCompare(b.path),
    )
    .slice(0, excess)
    .map((entry) => entry.path);
}

/** Every file under `dir`, in every folder. */
export function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
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

  const carriedFiles: HistoryEntry[] = [];
  await eachLimited(toCarry, CONCURRENCY, async (path) => {
    const bytes = await download(site, path);
    if (bytes === null) return;
    // A write failure throws out of main and fails the deploy.
    const target = join(dist, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    carriedFiles.push({ path, firstSeen: firstSeen.get(path) ?? new Date(now).toISOString() });
  });

  // The hard cap. The history file this run writes counts too.
  const historyPath = join(dist, HISTORY_FILE);
  const before = countFiles(dist) + (existsSync(historyPath) ? 0 : 1);
  const dropped = filesToDrop(before, carriedFiles);
  for (const path of dropped) unlinkSync(join(dist, path));

  const stamp = new Date(now).toISOString();
  const files: HistoryEntry[] = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = `assets/${entry.name}`;
      return { path, firstSeen: firstSeen.get(path) ?? stamp };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(historyPath, `${JSON.stringify({ files }, null, 2)}\n`);
  log(
    `carried ${carriedFiles.length - dropped.length}/${toCarry.length} old assets; history lists ${files.length} files`,
  );
  process.stdout.write(`carry-assets: dist ${countFiles(dist)} files, dropped ${dropped.length}\n`);
}

// Run only as the CI step (node scripts/carry-assets.ts), never on import (tests).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[carry-assets] failed: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  });
}
