// Make playable MP4 copies of the old WebM voice notes (30 Sep - 21 Oct). iPhone
// Safari cannot play audio/webm; every note since 22 Oct is audio/mp4 already.
// Started by hand from GitHub Actions (voice-convert.yml).
//
//   node --experimental-transform-types --no-warnings scripts/voice-convert.ts dry-run
//   node --experimental-transform-types --no-warnings scripts/voice-convert.ts convert
//   node --experimental-transform-types --no-warnings scripts/voice-convert.ts verify
//
// Targets: asset_versions with mime_type audio/webm whose workspace and asset
// are both live and that have no 'compressed' rendition yet.
// dry-run: lists the targets (version id, workspace id, size); writes nothing.
// convert: per target, GET the original from R2, ffmpeg to AAC 64 kbps mono
//          with faststart, ffprobe the duration, PUT the copy at
//          ws/<workspace>/<asset>/<version>/compressed (audio/mp4), HEAD-check
//          its size, then INSERT the asset_renditions row (role 'compressed').
//          One failure is logged and the run goes on; the run fails at the end.
// verify:  every 'compressed' row's object exists at its recorded size, and
//          every live WebM target has a row. Fails the run on any mismatch.
//
// Hard safety: never deletes anything, never writes an original (PUT only to
// keys ending /compressed) and never writes asset_versions. Safe to re-run:
// versions with a row are skipped; a copy PUT without a row is overwritten.
// asset-read serves the copy for audio/webm versions once the row exists.
// Logs ids and sizes only.
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID,
// CLOUDFLARE_R2_SECRET_ACCESS_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  Db,
  PAGE_SIZE,
  R2,
  WS_PREFIX,
  env,
  isSampleKey,
  message,
  objectPath,
  runPool,
  summary,
  tracedFetch,
  uuidv7,
  type TracedFetch,
} from './storage-move.ts';

export const SOURCE_MIME = 'audio/webm';
export const COPY_MIME = 'audio/mp4';
export const COPY_ROLE = 'compressed';
export const CONVERT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

export type Mode = 'dry-run' | 'convert' | 'verify';

export function parseMode(argv: readonly string[]): Mode {
  const mode = argv[0];
  if (mode !== 'dry-run' && mode !== 'convert' && mode !== 'verify') {
    throw new Error('mode must be dry-run, convert or verify');
  }
  return mode;
}

/** One audio/webm version row with its parents' liveness. */
export interface WebmVersion {
  id: string;
  assetId: string;
  workspaceId: string;
  r2Key: string | null;
  sizeBytes: number | null;
  bucket: string | null;
  assetDeleted: boolean;
  workspaceDeleted: boolean;
}

/** One 'compressed' rendition row. */
export interface CopyRow {
  id: string;
  assetVersionId: string;
  r2Key: string;
  sizeBytes: number;
  bucket: string | null;
}

/** A version to convert. */
export interface Target {
  id: string;
  assetId: string;
  workspaceId: string;
  r2Key: string;
  sizeBytes: number | null;
  bucket: string;
}

/** The copy's key, next to the original (purged with its workspace and asset). */
export function copyKeyFor(target: { workspaceId: string; assetId: string; id: string }): string {
  return `${WS_PREFIX}${target.workspaceId}/${target.assetId}/${target.id}/${COPY_ROLE}`;
}

/**
 * Live WebM versions with a stored file and no copy yet. Skips deleted assets,
 * deleted workspaces, link/sample versions and versions already converted.
 */
export function selectTargets(
  versions: readonly WebmVersion[],
  convertedVersionIds: ReadonlySet<string>,
): Target[] {
  const out: Target[] = [];
  for (const v of versions) {
    if (v.assetDeleted || v.workspaceDeleted) continue;
    if (v.r2Key === null || isSampleKey(v.r2Key)) continue;
    if (v.bucket === null || v.bucket === '') continue;
    if (convertedVersionIds.has(v.id)) continue;
    out.push({
      id: v.id,
      assetId: v.assetId,
      workspaceId: v.workspaceId,
      r2Key: v.r2Key,
      sizeBytes: v.sizeBytes,
      bucket: v.bucket,
    });
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** ffprobe's format=duration (seconds) as whole ms, or null when unusable. */
export function parseDurationMs(stdout: string): number | null {
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.round(seconds * 1000));
}

// ---------------------------------------------------------------------------
// Convert and verify (IO injected; nothing here can delete)
// ---------------------------------------------------------------------------

export interface NewCopyRow {
  assetVersionId: string;
  workspaceId: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number | null;
}

/** Everything convert and verify touch. There is deliberately no delete. */
export interface ConvertDeps {
  webmVersions(): Promise<WebmVersion[]>;
  copyRows(): Promise<CopyRow[]>;
  getObject(bucket: string, key: string): Promise<Uint8Array>;
  /** PUT audio/mp4. Only ever called with a key ending /compressed. */
  putCopy(bucket: string, key: string, body: Uint8Array): Promise<void>;
  /** Object size, or null when absent. */
  headObject(bucket: string, key: string): Promise<number | null>;
  transcode(input: Uint8Array): Promise<{ bytes: Uint8Array; durationMs: number | null }>;
  insertCopyRow(row: NewCopyRow): Promise<void>;
  concurrency?: number;
}

export async function listTargets(deps: ConvertDeps): Promise<Target[]> {
  const [versions, copies] = await Promise.all([deps.webmVersions(), deps.copyRows()]);
  return selectTargets(versions, new Set(copies.map((c) => c.assetVersionId)));
}

export interface ConvertResult {
  id: string;
  ok: boolean;
  sourceBytes: number;
  copyBytes: number;
  durationMs: number | null;
  error?: string;
}

export async function convertOne(target: Target, deps: ConvertDeps): Promise<ConvertResult> {
  const key = copyKeyFor(target);
  // Belt and braces: the only object this script ever writes is a copy.
  if (!key.endsWith(`/${COPY_ROLE}`) || key === target.r2Key) {
    throw new Error(`refusing to write version ${target.id}: copy key would be the original`);
  }
  const source = await deps.getObject(target.bucket, target.r2Key);
  const { bytes, durationMs } = await deps.transcode(source);
  if (bytes.byteLength === 0) throw new Error('ffmpeg produced an empty file');
  await deps.putCopy(target.bucket, key, bytes);
  const stored = await deps.headObject(target.bucket, key);
  if (stored !== bytes.byteLength) {
    throw new Error(
      `copy is ${stored === null ? 'missing' : `${stored} bytes`}, wrote ${bytes.byteLength}`,
    );
  }
  await deps.insertCopyRow({
    assetVersionId: target.id,
    workspaceId: target.workspaceId,
    r2Key: key,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    durationMs,
  });
  return {
    id: target.id,
    ok: true,
    sourceBytes: source.byteLength,
    copyBytes: bytes.byteLength,
    durationMs,
  };
}

/** Convert every target; one failure is recorded and the rest go on. */
export async function convertAll(deps: ConvertDeps): Promise<ConvertResult[]> {
  const targets = await listTargets(deps);
  const results: ConvertResult[] = [];
  await runPool(targets, deps.concurrency ?? CONVERT_CONCURRENCY, async (target) => {
    try {
      results.push(await convertOne(target, deps));
    } catch (error) {
      results.push({
        id: target.id,
        ok: false,
        sourceBytes: target.sizeBytes ?? 0,
        copyBytes: 0,
        durationMs: null,
        error: message(error),
      });
    }
  });
  return results;
}

export interface VerifyResult {
  checked: number;
  problems: string[];
}

/** Every copy row's object exists at its size; every live WebM target has a row. */
export async function verifyCopies(deps: ConvertDeps): Promise<VerifyResult> {
  const [versions, copies] = await Promise.all([deps.webmVersions(), deps.copyRows()]);
  const problems: string[] = [];
  let checked = 0;
  await runPool(copies, deps.concurrency ?? CONVERT_CONCURRENCY, async (copy) => {
    if (copy.bucket === null || copy.bucket === '') {
      problems.push(`rendition ${copy.id}: workspace has no bucket`);
      return;
    }
    try {
      const size = await deps.headObject(copy.bucket, copy.r2Key);
      if (size === null) {
        problems.push(`rendition ${copy.id} (version ${copy.assetVersionId}): object missing`);
      } else if (size !== copy.sizeBytes) {
        problems.push(
          `rendition ${copy.id} (version ${copy.assetVersionId}): ${size} bytes, row says ${copy.sizeBytes}`,
        );
      } else {
        checked += 1;
      }
    } catch (error) {
      problems.push(`rendition ${copy.id}: ${message(error)}`);
    }
  });
  const missing = selectTargets(versions, new Set(copies.map((c) => c.assetVersionId)));
  for (const target of missing) problems.push(`version ${target.id}: no compressed copy`);
  return { checked, problems };
}

// ---------------------------------------------------------------------------
// IO: R2 GET/PUT, Supabase REST, ffmpeg
// ---------------------------------------------------------------------------

/** R2 with object GET and PUT on top of storage-move's signer. Still no delete. */
export class AudioR2 extends R2 {
  async getObject(bucket: string, key: string, traceId: string): Promise<Uint8Array> {
    const res = await this.signedFetch({ method: 'GET', path: objectPath(bucket, key), traceId });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`R2 GET failed (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async putCopy(bucket: string, key: string, body: Uint8Array, traceId: string): Promise<void> {
    if (!key.endsWith(`/${COPY_ROLE}`)) throw new Error('putCopy only writes /compressed keys');
    const res = await this.signedFetch({
      method: 'PUT',
      path: objectPath(bucket, key),
      body,
      contentType: COPY_MIME,
      traceId,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`R2 PUT failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

interface WebmRow {
  id: string;
  asset_id: string;
  workspace_id: string;
  r2_key: string | null;
  size_bytes: number | null;
  assets: { deleted_at: string | null } | null;
  workspaces: { deleted_at: string | null; asset_bucket: string | null } | null;
}

interface CopyDbRow {
  id: string;
  asset_version_id: string;
  r2_key: string;
  size_bytes: number;
  workspaces: { asset_bucket: string | null } | null;
}

export class VoiceDb extends Db {
  private readonly baseUrl: string;
  private readonly send: TracedFetch;

  constructor(url: string, key: string, fetch: TracedFetch) {
    super(url, key, fetch);
    this.baseUrl = url;
    this.send = fetch;
  }

  /** Every audio/webm version, 500 per request, keyset by id. */
  async webmVersions(traceId: string): Promise<WebmVersion[]> {
    const out: WebmVersion[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string = after === null ? '' : `&id=gt.${after}`;
      const page: WebmRow[] = await this.get<WebmRow>(
        'asset_versions?select=id,asset_id,workspace_id,r2_key,size_bytes,' +
          'assets!asset_id(deleted_at),workspaces(deleted_at,asset_bucket)' +
          `&mime_type=eq.${encodeURIComponent(SOURCE_MIME)}${cursor}&order=id&limit=${PAGE_SIZE}`,
        traceId,
      );
      for (const row of page) {
        out.push({
          id: row.id,
          assetId: row.asset_id,
          workspaceId: row.workspace_id,
          r2Key: row.r2_key,
          sizeBytes: row.size_bytes,
          bucket: row.workspaces?.asset_bucket ?? null,
          // A missing parent counts as deleted.
          assetDeleted: row.assets === null || row.assets.deleted_at !== null,
          workspaceDeleted: row.workspaces === null || row.workspaces.deleted_at !== null,
        });
      }
      const last = page[page.length - 1];
      if (page.length < PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    return out;
  }

  /** Every 'compressed' rendition, 500 per request, keyset by id. */
  async copyRows(traceId: string): Promise<CopyRow[]> {
    const out: CopyRow[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string = after === null ? '' : `&id=gt.${after}`;
      const page: CopyDbRow[] = await this.get<CopyDbRow>(
        'asset_renditions?select=id,asset_version_id,r2_key,size_bytes,workspaces(asset_bucket)' +
          `&role=eq.${COPY_ROLE}${cursor}&order=id&limit=${PAGE_SIZE}`,
        traceId,
      );
      for (const row of page) {
        out.push({
          id: row.id,
          assetVersionId: row.asset_version_id,
          r2Key: row.r2_key,
          sizeBytes: Number(row.size_bytes),
          bucket: row.workspaces?.asset_bucket ?? null,
        });
      }
      const last = page[page.length - 1];
      if (page.length < PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    return out;
  }

  /** INSERT one asset_renditions row (service role has SELECT and INSERT only). */
  async insertCopyRow(row: NewCopyRow, traceId: string): Promise<void> {
    const headers = this.headers();
    headers.set('Prefer', 'return=minimal');
    const res = await this.send(
      `${this.baseUrl}/rest/v1/asset_renditions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          asset_version_id: row.assetVersionId,
          workspace_id: row.workspaceId,
          role: COPY_ROLE,
          r2_key: row.r2Key,
          mime_type: COPY_MIME,
          sha256: row.sha256,
          size_bytes: row.sizeBytes,
          duration_ms: row.durationMs,
        }),
      },
      traceId,
    );
    if (!res.ok) {
      throw new Error(`asset_renditions insert failed (${res.status}): ${await res.text()}`);
    }
  }
}

const run = promisify(execFile);

/** ffmpeg to AAC 64 kbps mono M4A (faststart), then ffprobe the duration. */
export async function ffmpegTranscode(
  input: Uint8Array,
): Promise<{ bytes: Uint8Array; durationMs: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), 'voice-convert-'));
  try {
    const inPath = join(dir, 'in.webm');
    const outPath = join(dir, 'out.m4a');
    await writeFile(inPath, input);
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inPath,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      outPath,
    ]);
    const probe = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      outPath,
    ]);
    return {
      bytes: new Uint8Array(await readFile(outPath)),
      durationMs: parseDurationMs(probe.stdout),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  const traceId = uuidv7();
  const r2 = new AudioR2(
    {
      CLOUDFLARE_ACCOUNT_ID: env('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_R2_ACCESS_KEY_ID: env('CLOUDFLARE_R2_ACCESS_KEY_ID'),
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: env('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
    },
    tracedFetch,
  );
  const db = new VoiceDb(
    env('SUPABASE_URL').replace(/\/+$/, ''),
    env('SUPABASE_SECRET_KEY'),
    tracedFetch,
  );
  const deps: ConvertDeps = {
    webmVersions: () => db.webmVersions(traceId),
    copyRows: () => db.copyRows(traceId),
    getObject: (bucket, key) => r2.getObject(bucket, key, traceId),
    putCopy: (bucket, key, body) => r2.putCopy(bucket, key, body, traceId),
    headObject: (bucket, key) => r2.headObject(bucket, key, traceId),
    transcode: ffmpegTranscode,
    insertCopyRow: (row) => db.insertCopyRow(row, traceId),
  };
  const out: string[] = [`## Voice convert ${mode} (run trace ${traceId})`];

  if (mode === 'dry-run') {
    const targets = await listTargets(deps);
    const bytes = targets.reduce((sum, t) => sum + (t.sizeBytes ?? 0), 0);
    out.push(`- targets: ${targets.length} (${bytes} bytes)`);
    out.push(...targets.map((t) => `  - ${t.id} workspace=${t.workspaceId} size=${t.sizeBytes}`));
    summary(out);
    return 0;
  }

  if (mode === 'convert') {
    const results = await convertAll(deps);
    const failed = results.filter((r) => !r.ok);
    const copyBytes = results.reduce((sum, r) => sum + r.copyBytes, 0);
    out.push(
      `- converted ${results.length - failed.length}, failed ${failed.length}, copies ${copyBytes} bytes`,
    );
    for (const r of results) {
      out.push(
        r.ok
          ? `  - ${r.id} ok ${r.sourceBytes} -> ${r.copyBytes} bytes, ${r.durationMs ?? '?'} ms`
          : `  - ${r.id} FAILED: ${r.error ?? 'unknown'}`,
      );
    }
    summary(out);
    return failed.length > 0 ? 1 : 0;
  }

  const result = await verifyCopies(deps);
  out.push(
    `- copies checked ${result.checked}, ${result.problems.length === 0 ? 'OK' : `MISMATCH ${result.problems.length}`}`,
  );
  out.push(...result.problems.map((p) => `  - ${p}`));
  summary(out);
  return result.problems.length > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${message(error)}\n`);
      process.exit(1);
    },
  );
}
