// Step 8: asset migration. Copies v1 media bytes into the v2 per-workspace R2
// bucket and records assets + asset_versions + asset_attachments, plus
// client-shared Drive links as link-kind assets (no bytes). Runs inside the same
// transaction as the other loaders.
//
// Scope (locked): posts.images + posts.drive_link attach to the post;
// requests.images + requests.drive_link attach to the brief; post_comments
// .attachments attach to the comment. canva_link / linkedin_link are dropped.
//
// Resilience: a single bad URL, disallowed MIME, or unmapped entity is recorded
// and skipped, never fatal. Only contract failures (missing R2 credentials) throw.
//
// Memory: media reads are paged and bytes are fetched-uploaded-freed one file at
// a time; only small row metadata accumulates for the set-based inserts.

import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import {
  buildR2Key,
  computeSha256,
  isAllowedMime,
  normalizeMime,
  R2StorageClient,
  type R2StorageEnv,
  type StorageClient,
  type TracedFetch,
} from '@srtdio/storage';

import type { EtlConfig } from './config';
import { chunk, insertRows, INSERT_CHUNK, type Row } from './load';
import { BATCH_SIZE, type SourceDb } from './source';
import {
  type AssetKind,
  filenameFromUrl,
  isHttpUrl,
  linkLabel,
  mimeToKind,
  normalizeMediaPath,
  parseMediaUrls,
  sniffMime,
  truncate,
} from './transform';

// assets.filename CHECK is 1..500 (schema.md section 5).
const FILENAME_MAX = 500;

const ASSET_COLS = ['id', 'workspace_id', 'filename', 'current_version_id', 'uploaded_by'] as const;
const VERSION_COLS = [
  'id',
  'asset_id',
  'workspace_id',
  'version_number',
  'kind',
  'r2_key',
  'mime_type',
  'sha256',
  'size_bytes',
  'external_url',
  'uploaded_by',
] as const;
const ATTACHMENT_COLS = [
  'id',
  'asset_id',
  'asset_version_id',
  'entity_type',
  'entity_id',
  'workspace_id',
  'position',
  'attached_by',
] as const;

type EntityType = 'post' | 'brief' | 'comment';

export type MediaItem = {
  type: 'file' | 'link';
  url: string;
  entityType: EntityType;
  entityId: string;
  position: number;
};

// The result of pulling one file's bytes. A non-ok result carries the status so
// the failure summary is actionable.
export type FetchResult = { ok: true; bytes: Uint8Array } | { ok: false; status: number };

export interface PlanContext {
  workspaceId: string;
  operatorUserId: string;
  bucket: string;
  traceId: string;
}

export interface PlanDeps {
  storage: StorageClient;
  fetchBytes: (url: string) => Promise<FetchResult>;
}

export interface AssetLoadSummary {
  filesMigrated: number;
  linksMigrated: number;
  deduped: number;
  skipped: number;
  failed: number;
}

interface AssetFailure {
  ref: string;
  reason: string;
}

interface VersionRef {
  assetId: string;
  versionId: string;
}

export interface AssetPlan {
  assetRows: Row[];
  versionRows: Row[];
  attachmentRows: Row[];
  currentVersions: VersionRef[];
  failures: AssetFailure[];
  summary: AssetLoadSummary;
}

// Mutable accumulator threaded through the per-item processors. byPath is the
// pre-fetch dedup (same object under two hosts); bySha is the authoritative
// post-fetch dedup. Both reuse an already-uploaded version for a new attachment.
interface Accumulator {
  plan: AssetPlan;
  byPath: Map<string, VersionRef>;
  bySha: Map<string, VersionRef>;
}

function emptyPlan(): AssetPlan {
  return {
    assetRows: [],
    versionRows: [],
    attachmentRows: [],
    currentVersions: [],
    failures: [],
    summary: { filesMigrated: 0, linksMigrated: 0, deduped: 0, skipped: 0, failed: 0 },
  };
}

function pushAsset(
  plan: AssetPlan,
  ctx: PlanContext,
  asset: VersionRef & { filename: string },
): void {
  plan.assetRows.push({
    id: asset.assetId,
    workspace_id: ctx.workspaceId,
    filename: asset.filename,
    current_version_id: null,
    uploaded_by: ctx.operatorUserId,
  });
  plan.currentVersions.push({ assetId: asset.assetId, versionId: asset.versionId });
}

function attachmentRow(ctx: PlanContext, ref: VersionRef, item: MediaItem): Row {
  return {
    id: uuidv7(),
    asset_id: ref.assetId,
    asset_version_id: ref.versionId,
    entity_type: item.entityType,
    entity_id: item.entityId,
    workspace_id: ctx.workspaceId,
    position: item.position,
    attached_by: ctx.operatorUserId,
  };
}

function fileVersionRow(
  ctx: PlanContext,
  ref: VersionRef,
  meta: { kind: AssetKind; key: string; mime: string; sha: string; size: number },
): Row {
  return {
    id: ref.versionId,
    asset_id: ref.assetId,
    workspace_id: ctx.workspaceId,
    version_number: 1,
    kind: meta.kind,
    r2_key: meta.key,
    mime_type: meta.mime,
    sha256: meta.sha,
    size_bytes: meta.size,
    external_url: null,
    uploaded_by: ctx.operatorUserId,
  };
}

function linkVersionRow(ctx: PlanContext, ref: VersionRef, url: string): Row {
  return {
    id: ref.versionId,
    asset_id: ref.assetId,
    workspace_id: ctx.workspaceId,
    version_number: 1,
    kind: 'link' satisfies AssetKind,
    r2_key: null,
    mime_type: null,
    sha256: null,
    size_bytes: null,
    external_url: url,
    uploaded_by: ctx.operatorUserId,
  };
}

function fail(acc: Accumulator, ref: string, reason: string): void {
  acc.plan.failures.push({ ref, reason });
  acc.plan.summary.failed += 1;
}

// A link asset: clean https only, no bytes, no R2 write.
function processLink(item: MediaItem, ctx: PlanContext, acc: Accumulator): void {
  if (!isHttpUrl(item.url)) {
    acc.plan.summary.skipped += 1;
    return;
  }
  const ref: VersionRef = { assetId: uuidv7(), versionId: uuidv7() };
  pushAsset(acc.plan, ctx, { ...ref, filename: truncate(linkLabel(item.url), FILENAME_MAX) });
  acc.plan.versionRows.push(linkVersionRow(ctx, ref, item.url));
  acc.plan.attachmentRows.push(attachmentRow(ctx, ref, item));
  acc.plan.summary.linksMigrated += 1;
}

// A file asset: fetch the bytes, dedup by path then sha, sniff + validate the
// MIME, upload to R2, and accumulate the asset/version/attachment rows. Bytes are
// dropped when the function returns; only metadata is retained.
async function processFile(
  item: MediaItem,
  ctx: PlanContext,
  deps: PlanDeps,
  acc: Accumulator,
): Promise<void> {
  const path = normalizeMediaPath(item.url);
  const pathHit = acc.byPath.get(path);
  if (pathHit !== undefined) {
    acc.plan.attachmentRows.push(attachmentRow(ctx, pathHit, item));
    acc.plan.summary.deduped += 1;
    return;
  }

  const fetched = await deps.fetchBytes(item.url);
  if (!fetched.ok) {
    fail(acc, item.url, `fetch_failed_${fetched.status}`);
    return;
  }
  const bytes = fetched.bytes;
  if (bytes.length === 0) {
    fail(acc, item.url, 'empty_body');
    return;
  }

  const sha = await computeSha256(bytes);
  const shaHit = acc.bySha.get(sha);
  if (shaHit !== undefined) {
    acc.byPath.set(path, shaHit);
    acc.plan.attachmentRows.push(attachmentRow(ctx, shaHit, item));
    acc.plan.summary.deduped += 1;
    return;
  }

  const mime = normalizeMime(sniffMime(bytes, filenameFromUrl(item.url)));
  if (!isAllowedMime(mime)) {
    fail(acc, item.url, 'mime_not_allowed');
    return;
  }

  const ref: VersionRef = { assetId: uuidv7(), versionId: uuidv7() };
  const filename = truncate(filenameFromUrl(item.url), FILENAME_MAX);
  const key = buildR2Key({
    kind: mimeToKind(mime),
    assetId: ref.assetId,
    versionNumber: 1,
    filename,
  });
  await deps.storage.putObject({
    bucket: ctx.bucket,
    key,
    body: bytes,
    contentType: mime,
    traceId: ctx.traceId,
  });

  pushAsset(acc.plan, ctx, { ...ref, filename });
  acc.plan.versionRows.push(
    fileVersionRow(ctx, ref, { kind: mimeToKind(mime), key, mime, sha, size: bytes.length }),
  );
  acc.bySha.set(sha, ref);
  acc.byPath.set(path, ref);
  acc.plan.attachmentRows.push(attachmentRow(ctx, ref, item));
  acc.plan.summary.filesMigrated += 1;
}

// Walk the collected media items once, fetching/uploading file bytes and shaping
// every row. Pure of the DB: tests drive this with a mock fetch + storage and
// assert on the returned plan.
export async function buildAssetPlan(
  items: readonly MediaItem[],
  ctx: PlanContext,
  deps: PlanDeps,
): Promise<AssetPlan> {
  const acc: Accumulator = { plan: emptyPlan(), byPath: new Map(), bySha: new Map() };
  for (const item of items) {
    if (item.type === 'link') processLink(item, ctx, acc);
    else await processFile(item, ctx, deps, acc);
  }
  return acc.plan;
}

// images first (position = index), then the drive link (position = image count).
function appendEntityMedia(
  items: MediaItem[],
  entity: { entityType: EntityType; entityId: string; images: unknown; driveLink: string | null },
): void {
  const urls = parseMediaUrls(entity.images);
  urls.forEach((url, position) =>
    items.push({
      type: 'file',
      url,
      entityType: entity.entityType,
      entityId: entity.entityId,
      position,
    }),
  );
  if (entity.driveLink !== null && entity.driveLink.trim() !== '') {
    items.push({
      type: 'link',
      url: entity.driveLink,
      entityType: entity.entityType,
      entityId: entity.entityId,
      position: urls.length,
    });
  }
}

function hasMedia(images: unknown, driveLink: string | null): boolean {
  return parseMediaUrls(images).length > 0 || (driveLink !== null && isHttpUrl(driveLink));
}

// Page every v1 source, resolving each entity to its v2 id, and flatten into one
// ordered item list. Media whose entity was not migrated is recorded as a failure
// (post media uses the v1 post id verbatim, so only briefs/comments can miss).
async function collectMediaItems(
  source: SourceDb,
  briefsMap: ReadonlyMap<string, string>,
  commentsMap: ReadonlyMap<string, string>,
): Promise<{ items: MediaItem[]; failures: AssetFailure[] }> {
  const items: MediaItem[] = [];
  const failures: AssetFailure[] = [];

  for (let offset = 0; ; offset += BATCH_SIZE) {
    const batch = await source.fetchPostMediaBatch(offset, BATCH_SIZE);
    if (batch.length === 0) break;
    for (const p of batch) {
      appendEntityMedia(items, {
        entityType: 'post',
        entityId: p.id,
        images: p.images,
        driveLink: p.drive_link,
      });
    }
    if (batch.length < BATCH_SIZE) break;
  }

  for (let offset = 0; ; offset += BATCH_SIZE) {
    const batch = await source.fetchRequestMediaBatch(offset, BATCH_SIZE);
    if (batch.length === 0) break;
    for (const r of batch) {
      const briefId = briefsMap.get(r.id);
      if (briefId === undefined) {
        if (hasMedia(r.images, r.drive_link))
          failures.push({ ref: r.id, reason: 'brief_not_mapped' });
        continue;
      }
      appendEntityMedia(items, {
        entityType: 'brief',
        entityId: briefId,
        images: r.images,
        driveLink: r.drive_link,
      });
    }
    if (batch.length < BATCH_SIZE) break;
  }

  for (let offset = 0; ; offset += BATCH_SIZE) {
    const batch = await source.fetchCommentAttachmentsBatch(offset, BATCH_SIZE);
    if (batch.length === 0) break;
    for (const c of batch) {
      const urls = parseMediaUrls(c.attachments);
      if (urls.length === 0) continue;
      const commentId = commentsMap.get(c.id);
      if (commentId === undefined) {
        failures.push({ ref: c.id, reason: 'comment_not_mapped' });
        continue;
      }
      urls.forEach((url, position) =>
        items.push({ type: 'file', url, entityType: 'comment', entityId: commentId, position }),
      );
    }
    if (batch.length < BATCH_SIZE) break;
  }

  return { items, failures };
}

// Close the asset<->version FK cycle: assets insert with current_version_id NULL,
// then one set-based UPDATE per chunk points each asset at its version.
async function setCurrentVersions(client: PoolClient, links: readonly VersionRef[]): Promise<void> {
  for (const part of chunk(links, INSERT_CHUNK)) {
    if (part.length === 0) continue;
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const link of part) {
      tuples.push(`($${p++}::uuid, $${p++}::uuid)`);
      params.push(link.assetId, link.versionId);
    }
    await client.query(
      `UPDATE public.assets AS a SET current_version_id = v.version_id
         FROM (VALUES ${tuples.join(', ')}) AS v(asset_id, version_id)
        WHERE a.id = v.asset_id`,
      params,
    );
  }
}

function readR2Env(): R2StorageEnv {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  if (
    accountId === undefined ||
    accountId === '' ||
    accessKeyId === undefined ||
    accessKeyId === '' ||
    secretAccessKey === undefined ||
    secretAccessKey === ''
  ) {
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

// A Node TracedFetch matching @srtdio/storage's type: wrap global fetch and, when
// a trace id is given, inject the X-Trace-Id header. globalThis.fetch (not the
// bare global) keeps this runtime-neutral and clear of the app's fetch lint rule.
const tracedFetch: TracedFetch = (input, init, traceId) => {
  if (traceId === undefined) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('X-Trace-Id', traceId);
  return globalThis.fetch(input, { ...init, headers });
};

async function fetchBytesViaHttp(url: string): Promise<FetchResult> {
  const res = await globalThis.fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const buffer = await res.arrayBuffer();
  return { ok: true, bytes: new Uint8Array(buffer) };
}

function logSummary(plan: AssetPlan): void {
  // A CLI script (packages/etl, not app src/**): console is the expected sink.
  console.log(`[etl] assets summary: ${JSON.stringify(plan.summary)}`);
  if (plan.summary.failed > 0) {
    for (const f of plan.failures) console.log(`[etl] asset failure: ${JSON.stringify(f)}`);
  }
}

// Step entry. Originates the one run trace id (nothing upstream provides one),
// ensures the per-workspace bucket once, builds the plan, then inserts every row
// set-based and points assets at their current version.
export async function loadAssets(
  client: PoolClient,
  source: SourceDb,
  config: EtlConfig,
  workspaceId: string,
  bucket: string,
  briefsMap: ReadonlyMap<string, string>,
  commentsMap: ReadonlyMap<string, string>,
): Promise<AssetLoadSummary> {
  const traceId = uuidv7();
  const storage = new R2StorageClient(readR2Env(), tracedFetch);
  await storage.ensureBucket(bucket, traceId);

  const ctx: PlanContext = {
    workspaceId,
    operatorUserId: config.operatorUserId,
    bucket,
    traceId,
  };

  const collected = await collectMediaItems(source, briefsMap, commentsMap);
  const plan = await buildAssetPlan(collected.items, ctx, {
    storage,
    fetchBytes: fetchBytesViaHttp,
  });
  for (const f of collected.failures) plan.failures.push(f);
  plan.summary.failed += collected.failures.length;

  await insertRows(client, 'public.assets', ASSET_COLS, plan.assetRows);
  await insertRows(client, 'public.asset_versions', VERSION_COLS, plan.versionRows);
  await setCurrentVersions(client, plan.currentVersions);
  await insertRows(client, 'public.asset_attachments', ATTACHMENT_COLS, plan.attachmentRows);

  logSummary(plan);
  return plan.summary;
}
