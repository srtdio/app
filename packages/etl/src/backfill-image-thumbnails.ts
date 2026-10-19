// One-time, idempotent backfill of small list copies for post images uploaded
// before images got one at upload. For every live post attachment whose image
// version (raster, never SVG) has no 'thumbnail' rendition yet, it reads the
// original from R2, writes a 320px-wide JPEG (fit inside 320 x 1160, never
// upscaled, EXIF orientation applied, metadata dropped) at the same key the
// upload path uses ({kindFolder}/{asset_id}/v{n}-thumb.jpg), then inserts the
// asset_renditions row ON CONFLICT DO NOTHING. A second run finds nothing to do.
//
// Run via the etl CLI subcommand (see index.ts):
//   pnpm --filter @srtdio/etl etl backfill-image-thumbnails --mode=dry-run|apply
// dry-run (default) counts what it would make and writes NOTHING. Target only:
// TARGET_DATABASE_URL must resolve to EXPECTED_TARGET_REF (the v2 project).
// Versions are processed in pages; one failed image is logged and skipped,
// never aborting the rest (the next run picks it up again).

import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import sharp from 'sharp';
import { v7 as uuidv7 } from 'uuid';

import {
  R2StorageClient,
  buildThumbnailKey,
  type R2StorageEnv,
  type TracedFetch,
} from '@srtdio/storage';

import { targetRefMatches } from './config';

export type ThumbnailBackfillMode = 'dry-run' | 'apply';

/** Matches the app's IMAGE_THUMBNAIL_MAX_WIDTH and the server's height cap. */
export const LIST_COPY_MAX_WIDTH = 320;
export const LIST_COPY_MAX_HEIGHT = 1160;
/** The server's thumbnail byte cap (THUMBNAIL_MAX_BYTES). */
export const LIST_COPY_MAX_BYTES = 300 * 1024;
/** Originals larger than this are skipped (the app's THUMBNAIL_SOURCE_MAX_BYTES). */
const SOURCE_MAX_BYTES = 60 * 1024 * 1024;
const PAGE_SIZE = 200;
/** Images worked on at once: bounded so memory stays small. */
const CONCURRENCY = 4;

function log(message: string): void {
  // A CLI script (not app src/**): console is the expected output sink here.
  console.log(`[etl:thumbs] ${message}`);
}

/** --mode=dry-run|apply (default dry-run); unknown flags abort. Pure. */
export function parseThumbnailMode(argv: readonly string[]): ThumbnailBackfillMode {
  let mode: ThumbnailBackfillMode = 'dry-run';
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--mode=dry-run' || arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--mode=apply' || arg === '--apply') mode = 'apply';
    else throw new Error(`Unknown flag for backfill-image-thumbnails: ${arg}`);
  }
  return mode;
}

/** The list copy's size: fit inside 320 x 1160, never upscaled. Pure. */
export function listCopyBox(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LIST_COPY_MAX_WIDTH / width, LIST_COPY_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface ImageVersionToThumb {
  version_id: string;
  asset_id: string;
  workspace_id: string;
  version_number: number;
  r2_key: string;
  asset_bucket: string;
}

// Every image version a live post attachment pins that has no thumbnail yet.
// Keyset-paged on version id so a run is bounded per round trip.
const PAGE_SQL = `
  select distinct v.id as version_id, v.asset_id, v.workspace_id, v.version_number,
         v.r2_key, w.asset_bucket
  from asset_attachments a
  join asset_versions v on v.id = a.asset_version_id
  join workspaces w on w.id = v.workspace_id
  where a.entity_type = 'post'
    and a.deleted_at is null
    and v.r2_key is not null
    and w.asset_bucket is not null
    and v.mime_type like 'image/%'
    and v.mime_type <> 'image/svg+xml'
    and v.id > $1
    and not exists (
      select 1 from asset_renditions r
      where r.asset_version_id = v.id and r.role = 'thumbnail'
    )
  order by v.id
  limit $2`;

const INSERT_SQL = `
  insert into asset_renditions
    (id, asset_version_id, workspace_id, role, r2_key, mime_type, sha256, size_bytes, width, height)
  values ($1, $2, $3, 'thumbnail', $4, 'image/jpeg', $5, $6, $7, $8)
  on conflict (asset_version_id, role) do nothing`;

/** Encode the list copy at 0.8, stepping to 0.6 over the byte cap; null when still over. */
async function encodeListCopy(
  original: Uint8Array,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  for (const quality of [80, 60]) {
    const { data, info } = await sharp(original, { failOn: 'none' })
      .rotate()
      .resize({
        width: LIST_COPY_MAX_WIDTH,
        height: LIST_COPY_MAX_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= LIST_COPY_MAX_BYTES) {
      return { bytes: new Uint8Array(data), width: info.width, height: info.height };
    }
  }
  return null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type Outcome = 'made' | 'skipped' | 'failed';

async function thumbOne(
  deps: { pool: Pool; storage: R2StorageClient; traceId: string },
  row: ImageVersionToThumb,
): Promise<Outcome> {
  try {
    const original = await deps.storage.getObject(row.asset_bucket, row.r2_key, deps.traceId);
    if (original === null || original.byteLength > SOURCE_MAX_BYTES) return 'skipped';
    const copy = await encodeListCopy(original);
    if (copy === null) return 'skipped';
    const key = buildThumbnailKey({
      kind: 'image',
      assetId: row.asset_id,
      versionNumber: row.version_number,
    });
    // A file literally named "...-thumb.jpg" keys to the same object: never overwrite it.
    if (key === row.r2_key) return 'skipped';
    await deps.storage.putObject({
      bucket: row.asset_bucket,
      key,
      body: copy.bytes,
      contentType: 'image/jpeg',
      traceId: deps.traceId,
    });
    await deps.pool.query(INSERT_SQL, [
      uuidv7(),
      row.version_id,
      row.workspace_id,
      key,
      sha256Hex(copy.bytes),
      copy.bytes.byteLength,
      copy.width,
      copy.height,
    ]);
    return 'made';
  } catch (error) {
    log(`failed ${row.version_id}: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

function readR2Env(): R2StorageEnv {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ?? '';
  if (accountId === '' || accessKeyId === '' || secretAccessKey === '') {
    throw new Error(
      'Missing R2 credentials: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY.',
    );
  }
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_R2_ACCESS_KEY_ID: accessKeyId,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: secretAccessKey,
  };
}

const tracedFetch: TracedFetch = (input, init, traceId) => {
  if (traceId === undefined) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('X-Trace-Id', traceId);
  return globalThis.fetch(input, { ...init, headers });
};

/** Run the backfill. Throws only on a config or safety failure, never per image. */
export async function runBackfillImageThumbnails(argv: readonly string[]): Promise<void> {
  const mode = parseThumbnailMode(argv);
  const targetUrl = process.env.TARGET_DATABASE_URL ?? '';
  const expectedRef = process.env.EXPECTED_TARGET_REF ?? '';
  if (targetUrl === '' || expectedRef === '') {
    throw new Error('TARGET_DATABASE_URL and EXPECTED_TARGET_REF are required.');
  }
  if (!targetRefMatches(targetUrl, expectedRef)) {
    throw new Error('Refusing to run: TARGET_DATABASE_URL is not the expected target project.');
  }
  const traceId = uuidv7();
  const pool = new Pool({ connectionString: targetUrl, max: CONCURRENCY + 1 });
  try {
    const storage = mode === 'apply' ? new R2StorageClient(readR2Env(), tracedFetch) : null;
    const counts = { found: 0, made: 0, skipped: 0, failed: 0 };
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await pool.query<ImageVersionToThumb>(PAGE_SQL, [after, PAGE_SIZE]);
      if (page.rows.length === 0) break;
      counts.found += page.rows.length;
      after = page.rows[page.rows.length - 1]?.version_id ?? after;
      if (storage === null) continue;
      for (let i = 0; i < page.rows.length; i += CONCURRENCY) {
        const batch = page.rows.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.all(
          batch.map((row) => thumbOne({ pool, storage, traceId }, row)),
        );
        for (const outcome of outcomes) counts[outcome] += 1;
      }
    }
    log(
      `${mode}: ${counts.found} image versions without a list copy; made ${counts.made}, skipped ${counts.skipped}, failed ${counts.failed}.`,
    );
  } finally {
    await pool.end();
  }
}
