// Copy one workspace's R2 bucket into a new Asia-Pacific bucket, or verify a
// copy. Started by hand from GitHub Actions (copy-workspace-storage.yml).
//
//   node --experimental-transform-types scripts/copy-workspace-storage.ts \
//     --source assets-gbl --target assets-gbl-apac --mode copy|verify
//
// copy:   creates the target bucket with the apac location hint (R2 honours a
//         hint only on first creation), then copies every source object
//         server-side (S3 CopyObject: same key, same Content-Type). Objects the
//         target already holds at the same size are skipped, so a re-run copies
//         only what is new (e.g. uploads made while the first run was going).
// verify: lists both buckets and reports counts, bytes, and every key missing
//         from the target or differing in size. Exits non-zero on any mismatch.
//
// Hard safety: never deletes anything, never overwrites an object that differs
// (it is reported instead), refuses source = target, refuses a target that does
// not start with "assets-", and never touches the database. Switching a
// workspace to the new bucket is a separate, owner-approved SQL step.
//
// Uses only the R2 secrets (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID,
// CLOUDFLARE_R2_SECRET_ACCESS_KEY) from the environment.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { R2StorageClient, type ListedObject } from '../packages/storage/src/storage.ts';

/** The R2 operations the copy needs; R2StorageClient fits it, tests fake it. */
export interface CopyStorage {
  ensureBucket(bucket: string, traceId: string): Promise<void>;
  listObjects(input: {
    bucket: string;
    cursor?: string | null;
    limit?: number;
    traceId: string;
  }): Promise<{ objects: ListedObject[]; nextCursor: string | null }>;
  copyObject(input: {
    sourceBucket: string;
    targetBucket: string;
    key: string;
    traceId: string;
  }): Promise<void>;
}

export type Mode = 'copy' | 'verify';

export interface Options {
  source: string;
  target: string;
  mode: Mode;
}

export interface CopyReport {
  copied: number;
  skipped: number;
  /** Keys present in the target at a different size: left untouched. */
  conflicts: string[];
  failed: { key: string; reason: string }[];
}

export interface VerifyReport {
  sourceCount: number;
  targetCount: number;
  sourceBytes: number;
  targetBytes: number;
  missing: string[];
  sizeMismatch: string[];
  ok: boolean;
}

/** Parse and validate the command line. Throws on anything unsafe. */
export function parseOptions(argv: readonly string[]): Options {
  const read = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`${flag} is required`);
    }
    return value.trim();
  };
  const source = read('--source');
  const target = read('--target');
  const mode = read('--mode');
  if (mode !== 'copy' && mode !== 'verify') {
    throw new Error('--mode must be copy or verify');
  }
  return validateOptions({ source, target, mode });
}

export function validateOptions(options: Options): Options {
  if (options.source === options.target) {
    throw new Error('source and target must be different buckets');
  }
  if (!options.target.startsWith('assets-')) {
    throw new Error('target must start with "assets-"');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.source)) {
    throw new Error('source is not a valid bucket name');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.target)) {
    throw new Error('target is not a valid bucket name');
  }
  return options;
}

/** Every object in a bucket, as key -> size. */
export async function listAll(
  storage: CopyStorage,
  bucket: string,
  traceId: string,
): Promise<Map<string, number>> {
  const all = new Map<string, number>();
  let cursor: string | null = null;
  do {
    const page: { objects: ListedObject[]; nextCursor: string | null } = await storage.listObjects({
      bucket,
      cursor,
      limit: 1000,
      traceId,
    });
    for (const object of page.objects) all.set(object.key, object.size);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

async function withRetry<T>(
  work: () => Promise<T>,
  attempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Run `work` over `items`, at most `limit` at a time. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

export async function copyBucket(
  storage: CopyStorage,
  options: Options,
  deps: { traceId: string; concurrency?: number; sleep?: (ms: number) => Promise<void> },
): Promise<CopyReport> {
  validateOptions(options);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  await storage.ensureBucket(options.target, deps.traceId);
  const [source, target] = await Promise.all([
    listAll(storage, options.source, deps.traceId),
    listAll(storage, options.target, deps.traceId),
  ]);
  const report: CopyReport = { copied: 0, skipped: 0, conflicts: [], failed: [] };
  const toCopy: string[] = [];
  for (const [key, size] of source) {
    const existing = target.get(key);
    if (existing === undefined) {
      toCopy.push(key);
    } else if (existing === size) {
      report.skipped += 1;
    } else {
      report.conflicts.push(key);
    }
  }
  await runPool(toCopy, deps.concurrency ?? 8, async (key) => {
    try {
      await withRetry(
        () =>
          storage.copyObject({
            sourceBucket: options.source,
            targetBucket: options.target,
            key,
            traceId: deps.traceId,
          }),
        4,
        sleep,
      );
      report.copied += 1;
    } catch (error) {
      report.failed.push({ key, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return report;
}

export async function verifyBuckets(
  storage: CopyStorage,
  options: Options,
  traceId: string,
): Promise<VerifyReport> {
  validateOptions(options);
  const [source, target] = await Promise.all([
    listAll(storage, options.source, traceId),
    listAll(storage, options.target, traceId),
  ]);
  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  for (const [key, size] of source) {
    const copy = target.get(key);
    if (copy === undefined) missing.push(key);
    else if (copy !== size) sizeMismatch.push(key);
  }
  const sum = (map: Map<string, number>): number => [...map.values()].reduce((a, b) => a + b, 0);
  return {
    sourceCount: source.size,
    targetCount: target.size,
    sourceBytes: sum(source),
    targetBytes: sum(target),
    missing,
    sizeMismatch,
    ok: missing.length === 0 && sizeMismatch.length === 0,
  };
}

function summary(lines: string[]): void {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file !== undefined && file !== '') appendFileSync(file, text);
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const traceId = randomUUID();
  const storage = new R2StorageClient(
    {
      CLOUDFLARE_ACCOUNT_ID: env('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_R2_ACCESS_KEY_ID: env('CLOUDFLARE_R2_ACCESS_KEY_ID'),
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: env('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
    },
    (input, init, trace) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Trace-Id', trace ?? traceId);
      return globalThis.fetch(input, { ...init, headers });
    },
  );
  if (options.mode === 'copy') {
    const report = await copyBucket(storage, options, { traceId });
    summary([
      `## Copy ${options.source} -> ${options.target}`,
      `- copied: ${report.copied}`,
      `- already there (same size): ${report.skipped}`,
      `- different size in target, left untouched: ${report.conflicts.length}`,
      ...report.conflicts.map((key) => `  - ${key}`),
      `- failed: ${report.failed.length}`,
      ...report.failed.map((f) => `  - ${f.key}: ${f.reason}`),
    ]);
    return report.failed.length === 0 && report.conflicts.length === 0 ? 0 : 1;
  }
  const report = await verifyBuckets(storage, options, traceId);
  summary([
    `## Verify ${options.source} -> ${options.target}: ${report.ok ? 'MATCH' : 'MISMATCH'}`,
    `- source: ${report.sourceCount} objects, ${report.sourceBytes} bytes`,
    `- target: ${report.targetCount} objects, ${report.targetBytes} bytes`,
    `- missing in target: ${report.missing.length}`,
    ...report.missing.map((key) => `  - ${key}`),
    `- size differs: ${report.sizeMismatch.length}`,
    ...report.sizeMismatch.map((key) => `  - ${key}`),
  ]);
  return report.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
