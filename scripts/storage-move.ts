// Move every workspace's files into the one shared bucket (srtdio-files) under
// ws/{workspace}/{asset}/{version}/{original|role} keys, then switch the
// workspace over in the database. Started by hand from GitHub Actions
// (storage-move.yml).
//
//   node --experimental-transform-types --no-warnings scripts/storage-move.ts setup
//   node --experimental-transform-types --no-warnings scripts/storage-move.ts move --all
//   node --experimental-transform-types --no-warnings scripts/storage-move.ts move --workspace <id>
//   node --experimental-transform-types --no-warnings scripts/storage-move.ts verify --all
//
// setup:  creates srtdio-files with the apac location hint if missing, and sets
//         its lifecycle rules (uploads/ deleted after 1 day, unfinished
//         multipart uploads aborted after 1 day). A token without the bucket
//         admin right gets a clear note and the run still passes.
// move:   for each live workspace not yet on srtdio-files: lists its version
//         and rendition rows 500 at a time (keyset by id), copies each object
//         server-side (S3 CopyObject) from the workspace's old bucket to its
//         new key in srtdio-files, HEAD-checks every copy against the source
//         size, then calls storage_workspace_move with the checked count. If
//         new files arrived meanwhile (object_count_changed) it lists again,
//         copies the new ones and retries, at most 3 times.
// verify: for each workspace on srtdio-files, every key in the database exists
//         in srtdio-files at the size the database records.
//
// Hard safety: never deletes anything and never overwrites an object that is
// already in srtdio-files at a different size (that workspace stops and is
// reported). Safe to re-run: copies already in place at the same size are
// skipped. Onboarding sample keys (induction-sample/) ship with the site and
// live in no bucket; they are counted but never copied (the database keeps
// those keys as they are).
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID,
// CLOUDFLARE_R2_SECRET_ACCESS_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY (move and
// verify), CLOUDFLARE_API_TOKEN (optional, setup fallback), TARGET_BUCKET
// (optional, default srtdio-files).

import { appendFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET_BUCKET = 'srtdio-files';
export const SAMPLE_PREFIX = 'induction-sample/';
export const WS_PREFIX = 'ws/';
export const PAGE_SIZE = 500;
export const MAX_COUNT_RETRIES = 3;
export const COPY_CONCURRENCY = 8;
export const LOCATION_HINT = 'apac';

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/** One database row that points at a stored object. */
export type DbObject =
  | {
      kind: 'version';
      id: string;
      workspaceId: string;
      assetId: string;
      r2Key: string;
      sizeBytes: number | null;
    }
  | {
      kind: 'rendition';
      id: string;
      workspaceId: string;
      /** The rendition's asset_version (asset_versions.id). */
      versionId: string;
      /** asset_versions.asset_id of that version. */
      assetId: string;
      role: string;
      r2Key: string;
      sizeBytes: number | null;
    };

export function isSampleKey(key: string): boolean {
  return key.startsWith(SAMPLE_PREFIX);
}

/**
 * The key an object has after storage_workspace_move, mirroring its SQL:
 *   version:   'ws/' || workspace_id || '/' || asset_id || '/' || id || '/original'
 *   rendition: 'ws/' || workspace_id || '/' || v.asset_id || '/' || v.id || '/' || role
 * Keys already under ws/ or induction-sample/ keep their key.
 */
export function newKeyFor(object: DbObject): string {
  if (object.r2Key.startsWith(WS_PREFIX) || isSampleKey(object.r2Key)) return object.r2Key;
  if (object.kind === 'version') {
    return `${WS_PREFIX}${object.workspaceId}/${object.assetId}/${object.id}/original`;
  }
  return `${WS_PREFIX}${object.workspaceId}/${object.assetId}/${object.versionId}/${object.role}`;
}

export type CopyPlan = 'copy' | 'skip' | 'conflict';

/** What to do with one object given the source size and the target's (null = absent). */
export function planCopy(sourceSize: number, targetSize: number | null): CopyPlan {
  if (targetSize === null) return 'copy';
  return targetSize === sourceSize ? 'skip' : 'conflict';
}

export type CountCheck = { ok: true } | { ok: false; expected: number; live: number };

/** The same comparison storage_workspace_move makes before renaming. */
export function countCheck(expected: number, live: number): CountCheck {
  return expected === live ? { ok: true } : { ok: false, expected, live };
}

/** uuid v7: 48-bit ms timestamp, version 7, variant 10, random rest. */
export function uuidv7(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Mode = 'setup' | 'move' | 'verify';

export interface Options {
  mode: Mode;
  /** A workspace id, or 'all'. Unused by setup. */
  workspace: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** argv after the script path: <mode> [--workspace <id|all> | --all]. */
export function parseOptions(argv: readonly string[]): Options {
  const mode = argv[0];
  if (mode !== 'setup' && mode !== 'move' && mode !== 'verify') {
    throw new Error('mode must be setup, move or verify');
  }
  if (mode === 'setup') return { mode, workspace: 'all' };
  let workspace: string | undefined;
  if (argv.includes('--all')) workspace = 'all';
  const index = argv.indexOf('--workspace');
  if (index >= 0) {
    const value = argv[index + 1]?.trim();
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error('--workspace needs a workspace id or "all"');
    }
    if (workspace !== undefined && value !== 'all') {
      throw new Error('pass either --all or --workspace <id>, not both');
    }
    workspace = value;
  }
  if (workspace === undefined) throw new Error('pass --workspace <id> or --all');
  if (workspace !== 'all' && !UUID_RE.test(workspace)) {
    throw new Error('--workspace must be a workspace uuid or "all"');
  }
  return { mode, workspace: workspace.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Move one workspace (IO injected; nothing here can delete)
// ---------------------------------------------------------------------------

export type MoveRpcResult = { ok: true } | { ok: false; countChanged: number };

/** Everything moveWithRetry touches. There is deliberately no delete. */
export interface MoveDeps {
  targetBucket: string;
  /** Every DB row with an r2_key for the workspace (paged inside). */
  listObjects(workspaceId: string): Promise<DbObject[]>;
  /** Object size, or null when absent. */
  headObject(bucket: string, key: string): Promise<number | null>;
  copyObject(input: {
    sourceBucket: string;
    sourceKey: string;
    targetBucket: string;
    targetKey: string;
  }): Promise<void>;
  /** storage_workspace_move. Throws on any error but object_count_changed. */
  moveRpc(input: {
    workspaceId: string;
    bucket: string;
    expectedObjects: number;
  }): Promise<MoveRpcResult>;
  concurrency?: number;
  maxRetries?: number;
}

export interface WorkspaceReport {
  workspaceId: string;
  copied: number;
  skipped: number;
  verified: number;
  moved: boolean;
  /** Why the workspace stopped (empty when moved). */
  problems: string[];
}

/** Run `work` over `items`, at most `limit` at a time. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy one workspace's objects into the target bucket, HEAD-check each one,
 * then switch it with storage_workspace_move. On object_count_changed re-list
 * (new rows get copied, done ones skip) and retry, up to maxRetries times.
 */
export async function moveWithRetry(
  workspace: { id: string; bucket: string },
  deps: MoveDeps,
): Promise<WorkspaceReport> {
  const report: WorkspaceReport = {
    workspaceId: workspace.id,
    copied: 0,
    skipped: 0,
    verified: 0,
    moved: false,
    problems: [],
  };
  const maxRetries = deps.maxRetries ?? MAX_COUNT_RETRIES;
  const done = new Set<string>();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const objects = await deps.listObjects(workspace.id);
    const problems: string[] = [];
    let verified = 0;

    await runPool(objects, deps.concurrency ?? COPY_CONCURRENCY, async (object) => {
      const doneKey = `${object.kind}:${object.id}`;
      if (done.has(doneKey)) {
        verified += 1;
        return;
      }
      if (isSampleKey(object.r2Key)) {
        // Ships with the site; in no bucket. Counted, never copied.
        done.add(doneKey);
        verified += 1;
        return;
      }
      const targetKey = newKeyFor(object);
      try {
        const [sourceSize, targetSize] = await Promise.all([
          deps.headObject(workspace.bucket, object.r2Key),
          deps.headObject(deps.targetBucket, targetKey),
        ]);
        if (sourceSize === null) {
          problems.push(
            `${object.kind} ${object.id}: source ${workspace.bucket}/${object.r2Key} not found`,
          );
          return;
        }
        const plan = planCopy(sourceSize, targetSize);
        if (plan === 'conflict') {
          problems.push(
            `${object.kind} ${object.id}: ${deps.targetBucket}/${targetKey} already holds ` +
              `${String(targetSize)} bytes, source has ${sourceSize}; left untouched`,
          );
          return;
        }
        if (plan === 'copy') {
          await deps.copyObject({
            sourceBucket: workspace.bucket,
            sourceKey: object.r2Key,
            targetBucket: deps.targetBucket,
            targetKey,
          });
          const copiedSize = await deps.headObject(deps.targetBucket, targetKey);
          if (copiedSize !== sourceSize) {
            problems.push(
              `${object.kind} ${object.id}: copy of ${targetKey} is ` +
                `${copiedSize === null ? 'missing' : `${copiedSize} bytes`}, source has ${sourceSize}`,
            );
            return;
          }
          report.copied += 1;
        } else {
          report.skipped += 1;
        }
        done.add(doneKey);
        verified += 1;
      } catch (error) {
        problems.push(`${object.kind} ${object.id}: ${message(error)}`);
      }
    });

    report.verified = verified;
    if (problems.length > 0) {
      report.problems.push(...problems);
      return report;
    }

    const result = await deps.moveRpc({
      workspaceId: workspace.id,
      bucket: deps.targetBucket,
      expectedObjects: verified,
    });
    if (result.ok) {
      report.moved = true;
      return report;
    }
    if (attempt === maxRetries) {
      report.problems.push(
        `object count kept changing (checked ${verified}, live ${result.countChanged}) ` +
          `after ${maxRetries} retries`,
      );
      return report;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Verify one workspace already on the target bucket
// ---------------------------------------------------------------------------

export interface VerifyReport {
  workspaceId: string;
  verified: number;
  problems: string[];
}

export async function verifyWorkspace(
  workspaceId: string,
  deps: Pick<MoveDeps, 'targetBucket' | 'listObjects' | 'headObject' | 'concurrency'>,
): Promise<VerifyReport> {
  const objects = await deps.listObjects(workspaceId);
  const report: VerifyReport = { workspaceId, verified: 0, problems: [] };
  await runPool(objects, deps.concurrency ?? COPY_CONCURRENCY, async (object) => {
    if (isSampleKey(object.r2Key)) {
      report.verified += 1;
      return;
    }
    try {
      const size = await deps.headObject(deps.targetBucket, object.r2Key);
      if (size === null) {
        report.problems.push(`${object.kind} ${object.id}: ${object.r2Key} missing`);
      } else if (object.sizeBytes !== null && size !== object.sizeBytes) {
        report.problems.push(
          `${object.kind} ${object.id}: ${object.r2Key} is ${size} bytes, database says ${object.sizeBytes}`,
        );
      } else {
        report.verified += 1;
      }
    } catch (error) {
      report.problems.push(`${object.kind} ${object.id}: ${message(error)}`);
    }
  });
  return report;
}

// ---------------------------------------------------------------------------
// R2 over S3 (SigV4), copied from packages/storage/src/storage.ts. Only GET,
// HEAD and PUT are ever sent.
// ---------------------------------------------------------------------------

export type TracedFetch = (
  input: string,
  init: RequestInit,
  traceId: string,
) => Promise<Response>;

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data)));
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function objectPath(bucket: string, key: string): string {
  return `/${encodeSegment(bucket)}/${key.split('/').map(encodeSegment).join('/')}`;
}

export function lifecycleXml(): string {
  return (
    '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    '<Rule><ID>expire-uploads</ID><Filter><Prefix>uploads/</Prefix></Filter>' +
    '<Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>' +
    '<Rule><ID>abort-multipart</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status>' +
    '<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation>' +
    '</AbortIncompleteMultipartUpload></Rule>' +
    '</LifecycleConfiguration>'
  );
}

export interface R2Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
}

export class R2 {
  private readonly host: string;

  constructor(
    private readonly env: R2Env,
    private readonly tracedFetch: TracedFetch,
  ) {
    this.host = `${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }

  /** Object size, or null on 404. */
  async headObject(bucket: string, key: string, traceId: string): Promise<number | null> {
    const res = await this.signedFetch({ method: 'HEAD', path: objectPath(bucket, key), traceId });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD ${bucket}/${key} failed (${res.status})`);
    const header = res.headers.get('content-length');
    const length = header === null ? Number.NaN : Number(header);
    if (!Number.isInteger(length) || length < 0) throw new Error(`R2 HEAD ${bucket}/${key}: no Content-Length`);
    return length;
  }

  /** Server-side copy; Content-Type and metadata come along. */
  async copyObject(input: {
    sourceBucket: string;
    sourceKey: string;
    targetBucket: string;
    targetKey: string;
    traceId: string;
  }): Promise<void> {
    const res = await this.signedFetch({
      method: 'PUT',
      path: objectPath(input.targetBucket, input.targetKey),
      amzHeaders: [['x-amz-copy-source', objectPath(input.sourceBucket, input.sourceKey)]],
      traceId: input.traceId,
    });
    const text = await res.text();
    if (!res.ok || /<Error>/.test(text)) {
      throw new Error(`R2 copy ${input.sourceKey} -> ${input.targetKey} failed (${res.status}): ${text}`);
    }
  }

  async bucketExists(bucket: string, traceId: string): Promise<boolean> {
    const res = await this.signedFetch({ method: 'HEAD', path: `/${encodeSegment(bucket)}`, traceId });
    return res.ok;
  }

  /** S3 CreateBucket with a location hint. Returns the raw response. */
  async createBucket(bucket: string, locationHint: string, traceId: string): Promise<Response> {
    return this.signedFetch({
      method: 'PUT',
      path: `/${encodeSegment(bucket)}`,
      body: enc.encode(
        '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          `<LocationConstraint>${locationHint}</LocationConstraint>` +
          '</CreateBucketConfiguration>',
      ),
      contentType: 'application/xml',
      traceId,
    });
  }

  /** S3 PutBucketLifecycleConfiguration. Returns the raw response. */
  async putLifecycle(bucket: string, xml: string, traceId: string): Promise<Response> {
    const body = enc.encode(xml);
    return this.signedFetch({
      method: 'PUT',
      path: `/${encodeSegment(bucket)}`,
      query: [['lifecycle', '']],
      body,
      contentType: 'application/xml',
      extraHeaders: [['content-md5', createHash('md5').update(body).digest('base64')]],
      traceId,
    });
  }

  private async signingKey(short: string): Promise<Uint8Array> {
    const kDate = await hmac(enc.encode(`AWS4${this.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY}`), short);
    const kRegion = await hmac(kDate, 'auto');
    const kService = await hmac(kRegion, 's3');
    return hmac(kService, 'aws4_request');
  }

  private async signedFetch(req: {
    method: 'GET' | 'HEAD' | 'PUT';
    path: string;
    query?: ReadonlyArray<readonly [string, string]>;
    body?: Uint8Array;
    contentType?: string;
    amzHeaders?: ReadonlyArray<readonly [string, string]>;
    /** Sent but not signed. */
    extraHeaders?: ReadonlyArray<readonly [string, string]>;
    traceId: string;
  }): Promise<Response> {
    const body = req.body ?? new Uint8Array(0);
    const full = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const short = full.slice(0, 8);
    const payloadHash = await sha256Hex(body);
    const signed = [
      ['host', this.host] as const,
      ['x-amz-content-sha256', payloadHash] as const,
      ['x-amz-date', full] as const,
      ...(req.amzHeaders ?? []),
    ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalHeaders = signed.map(([n, v]) => `${n}:${v.trim()}\n`).join('');
    const signedHeaders = signed.map(([n]) => n).join(';');
    const canonicalQuery = [...(req.query ?? [])]
      .map(([k, v]) => [encodeSegment(k), encodeSegment(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonicalRequest = [
      req.method,
      req.path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${short}/auto/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', full, scope, await sha256Hex(canonicalRequest)].join(
      '\n',
    );
    const signature = toHex(
      (await hmac(await this.signingKey(short), stringToSign)).buffer as ArrayBuffer,
    );
    const headers = new Headers({
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.env.CLOUDFLARE_R2_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': full,
      'content-type': req.contentType ?? 'application/octet-stream',
    });
    for (const [n, v] of [...(req.amzHeaders ?? []), ...(req.extraHeaders ?? [])]) headers.set(n, v);
    const init: RequestInit =
      req.method === 'PUT'
        ? { method: req.method, headers, body: body as BodyInit }
        : { method: req.method, headers };
    const url = `https://${this.host}${req.path}${canonicalQuery === '' ? '' : `?${canonicalQuery}`}`;
    return this.tracedFetch(url, init, req.traceId);
  }
}

// ---------------------------------------------------------------------------
// Supabase REST (service role)
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  bucket: string;
}

interface VersionRow {
  id: string;
  asset_id: string;
  r2_key: string;
  size_bytes: number | null;
}

interface RenditionRow {
  id: string;
  asset_version_id: string;
  role: string;
  r2_key: string;
  size_bytes: number | null;
  asset_versions: { asset_id: string } | null;
}

/** Parse a PostgREST error body for object_count_changed; returns the live count. */
export function parseCountChanged(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.message !== 'object_count_changed') return null;
  const live = Number(record.details);
  return Number.isInteger(live) ? live : null;
}

export class Db {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly tracedFetch: TracedFetch,
  ) {}

  private headers(): Headers {
    return new Headers({
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  }

  private async get<T>(path: string, traceId: string): Promise<T[]> {
    const res = await this.tracedFetch(
      `${this.url}/rest/v1/${path}`,
      { method: 'GET', headers: this.headers() },
      traceId,
    );
    if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0] ?? path} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T[];
  }

  async workspaces(filter: string, traceId: string): Promise<Workspace[]> {
    const idFilter = filter === 'all' ? '' : `&id=eq.${encodeURIComponent(filter)}`;
    const rows = await this.get<{ id: string; asset_bucket: string | null }>(
      `workspaces?select=id,asset_bucket&deleted_at=is.null${idFilter}&order=id`,
      traceId,
    );
    return rows.map((row) => ({ id: row.id, bucket: row.asset_bucket ?? '' }));
  }

  /** Every version and rendition row with an r2_key, 500 per request, keyset by id. */
  async objects(workspaceId: string, traceId: string): Promise<DbObject[]> {
    const ws = encodeURIComponent(workspaceId);
    const out: DbObject[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string = after === null ? '' : `&id=gt.${after}`;
      const page: VersionRow[] = await this.get<VersionRow>(
        `asset_versions?select=id,asset_id,r2_key,size_bytes&workspace_id=eq.${ws}` +
          `&r2_key=not.is.null${cursor}&order=id&limit=${PAGE_SIZE}`,
        traceId,
      );
      for (const row of page) {
        out.push({
          kind: 'version',
          id: row.id,
          workspaceId,
          assetId: row.asset_id,
          r2Key: row.r2_key,
          sizeBytes: row.size_bytes,
        });
      }
      const last = page[page.length - 1];
      if (page.length < PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    after = null;
    for (;;) {
      const cursor: string = after === null ? '' : `&id=gt.${after}`;
      const page: RenditionRow[] = await this.get<RenditionRow>(
        'asset_renditions?select=id,asset_version_id,role,r2_key,size_bytes,' +
          `asset_versions!inner(asset_id)&workspace_id=eq.${ws}` +
          `&r2_key=not.is.null${cursor}&order=id&limit=${PAGE_SIZE}`,
        traceId,
      );
      for (const row of page) {
        const assetId = row.asset_versions?.asset_id;
        if (assetId === undefined) throw new Error(`rendition ${row.id} has no asset version`);
        out.push({
          kind: 'rendition',
          id: row.id,
          workspaceId,
          versionId: row.asset_version_id,
          assetId,
          role: row.role,
          r2Key: row.r2_key,
          sizeBytes: row.size_bytes,
        });
      }
      const last = page[page.length - 1];
      if (page.length < PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    return out;
  }

  async storageWorkspaceMove(
    input: { workspaceId: string; bucket: string; expectedObjects: number },
    traceId: string,
  ): Promise<MoveRpcResult> {
    const res = await this.tracedFetch(
      `${this.url}/rest/v1/rpc/storage_workspace_move`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          p_workspace_id: input.workspaceId,
          p_bucket: input.bucket,
          p_expected_objects: input.expectedObjects,
          p_trace_id: traceId,
        }),
      },
      traceId,
    );
    if (res.ok) return { ok: true };
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const live = parseCountChanged(body);
    if (live !== null) return { ok: false, countChanged: live };
    throw new Error(`storage_workspace_move failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const LIFECYCLE_HELP =
  'Set the lifecycle rules once in the dashboard: R2 > srtdio-files > Settings > Object lifecycle ' +
  'rules: (1) prefix "uploads/", delete objects after 1 day; (2) whole bucket, abort incomplete ' +
  'multipart uploads after 1 day.';

export async function setup(
  r2: R2,
  bucket: string,
  traceId: string,
  cloudflare: { accountId: string; apiToken: string | null; fetch: TracedFetch },
): Promise<string[]> {
  const lines: string[] = [];
  if (await r2.bucketExists(bucket, traceId)) {
    lines.push(`- bucket ${bucket}: already exists (a location hint only applies at creation)`);
  } else {
    const res = await r2.createBucket(bucket, LOCATION_HINT, traceId);
    const text = await res.text();
    if (res.ok || /BucketAlreadyOwnedByYou/.test(text)) {
      lines.push(`- bucket ${bucket}: created with location hint ${LOCATION_HINT}`);
    } else if (res.status === 403) {
      throw new Error(
        `R2 token lacks Admin Read & Write (create bucket). Create ${bucket} once in the ` +
          `dashboard with location hint Asia-Pacific, then re-run setup. (${text})`,
      );
    } else {
      throw new Error(`create bucket ${bucket} failed (${res.status}): ${text}`);
    }
  }

  const s3 = await r2.putLifecycle(bucket, lifecycleXml(), traceId);
  if (s3.ok) {
    lines.push('- lifecycle: uploads/ deleted after 1 day; unfinished multipart aborted after 1 day');
    return lines;
  }
  const s3Text = await s3.text();
  if (cloudflare.apiToken !== null) {
    const api = await cloudflare.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/r2/buckets/${bucket}/lifecycle`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cloudflare.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rules: [
            {
              id: 'expire-uploads',
              enabled: true,
              conditions: { prefix: 'uploads/' },
              deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
            },
            {
              id: 'abort-multipart',
              enabled: true,
              conditions: { prefix: '' },
              abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } },
            },
          ],
        }),
      },
      traceId,
    );
    if (api.ok) {
      lines.push(
        '- lifecycle (Cloudflare API): uploads/ deleted after 1 day; unfinished multipart aborted after 1 day',
      );
      return lines;
    }
    const apiText = await api.text();
    lines.push(
      `- lifecycle NOT set. R2 S3 token answered ${s3.status} and CLOUDFLARE_API_TOKEN answered ` +
        `${api.status}: the API token lacks Workers R2 Storage: Edit (bucket lifecycle). ${LIFECYCLE_HELP}`,
      `  - S3: ${s3Text.slice(0, 300)}`,
      `  - API: ${apiText.slice(0, 300)}`,
    );
    return lines;
  }
  lines.push(
    s3.status === 403
      ? `- lifecycle NOT set. R2 token lacks Admin Read & Write (bucket lifecycle). ${LIFECYCLE_HELP}`
      : `- lifecycle NOT set (R2 answered ${s3.status}). ${LIFECYCLE_HELP}`,
    `  - S3: ${s3Text.slice(0, 300)}`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

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

const tracedFetch: TracedFetch = (input, init, traceId) => {
  const headers = new Headers(init.headers);
  headers.set('X-Trace-Id', traceId);
  return globalThis.fetch(input, { ...init, headers });
};

function line(r: { workspaceId: string; copied: number; skipped: number; verified: number; moved: boolean }): string {
  return (
    `${r.workspaceId} copied=${r.copied} skipped=${r.skipped} verified=${r.verified} ` +
    `moved=${r.moved ? 'yes' : 'no'}`
  );
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const targetBucket = process.env.TARGET_BUCKET?.trim() || DEFAULT_TARGET_BUCKET;
  const r2 = new R2(
    {
      CLOUDFLARE_ACCOUNT_ID: env('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_R2_ACCESS_KEY_ID: env('CLOUDFLARE_R2_ACCESS_KEY_ID'),
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: env('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
    },
    tracedFetch,
  );

  if (options.mode === 'setup') {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const lines = await setup(r2, targetBucket, uuidv7(), {
      accountId: env('CLOUDFLARE_ACCOUNT_ID'),
      apiToken: apiToken === undefined || apiToken === '' ? null : apiToken,
      fetch: tracedFetch,
    });
    summary([`## Storage setup: ${targetBucket}`, ...lines]);
    return 0;
  }

  const db = new Db(env('SUPABASE_URL').replace(/\/+$/, ''), env('SUPABASE_SECRET_KEY'), tracedFetch);
  const runTrace = uuidv7();
  const workspaces = await db.workspaces(options.workspace, runTrace);
  if (options.workspace !== 'all' && workspaces.length === 0) {
    throw new Error(`workspace ${options.workspace} not found (or deleted)`);
  }

  const out: string[] = [`## Storage ${options.mode} -> ${targetBucket} (run trace ${runTrace})`];
  let failed = false;

  for (const workspace of workspaces) {
    const traceId = uuidv7();
    const deps: MoveDeps = {
      targetBucket,
      listObjects: (id) => db.objects(id, traceId),
      headObject: (bucket, key) => r2.headObject(bucket, key, traceId),
      copyObject: (input) => r2.copyObject({ ...input, traceId }),
      moveRpc: (input) => db.storageWorkspaceMove(input, traceId),
    };

    if (options.mode === 'move') {
      if (workspace.bucket === targetBucket) {
        out.push(`- ${workspace.id} already on ${targetBucket}, skipped`);
        continue;
      }
      if (workspace.bucket === '') {
        out.push(`- ${workspace.id} has no asset_bucket; not moved`);
        failed = true;
        continue;
      }
      let report: WorkspaceReport;
      try {
        report = await moveWithRetry(workspace, deps);
      } catch (error) {
        report = {
          workspaceId: workspace.id,
          copied: 0,
          skipped: 0,
          verified: 0,
          moved: false,
          problems: [message(error)],
        };
      }
      out.push(`- ${line(report)} (from ${workspace.bucket}, trace ${traceId})`);
      out.push(...report.problems.slice(0, 50).map((p) => `  - ${p}`));
      if (report.problems.length > 50) out.push(`  - ... ${report.problems.length - 50} more`);
      if (!report.moved) failed = true;
      continue;
    }

    // verify
    if (workspace.bucket !== targetBucket) {
      out.push(`- ${workspace.id} still on ${workspace.bucket}, not verified`);
      continue;
    }
    let report: VerifyReport;
    try {
      report = await verifyWorkspace(workspace.id, deps);
    } catch (error) {
      report = { workspaceId: workspace.id, verified: 0, problems: [message(error)] };
    }
    out.push(
      `- ${line({ workspaceId: workspace.id, copied: 0, skipped: 0, verified: report.verified, moved: true })} ` +
        `${report.problems.length === 0 ? 'OK' : `MISMATCH ${report.problems.length}`}`,
    );
    out.push(...report.problems.slice(0, 50).map((p) => `  - ${p}`));
    if (report.problems.length > 50) out.push(`  - ... ${report.problems.length - 50} more`);
    if (report.problems.length > 0) failed = true;
  }

  summary(out);
  return failed ? 1 : 0;
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
