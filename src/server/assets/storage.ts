// Object storage boundary for R2.
//
// One bucket per workspace (assets-{workspace_id}), created lazily on first
// upload. The pipeline depends only on the StorageClient interface, so tests
// inject an in-memory implementation and never touch the network. The R2
// implementation talks to the S3-compatible API with SigV4 signing, using the
// R2 access-key credentials from env - no service binding, because buckets are
// created at runtime.

import { fetchWithTrace } from '@/lib/fetch';

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  traceId: string;
}

export interface StorageClient {
  /** Create the bucket if it does not already exist. Idempotent. */
  ensureBucket(bucket: string, traceId: string): Promise<void>;
  putObject(input: PutObjectInput): Promise<void>;
}

const ASSET_BUCKET_PREFIX = 'assets-';
export const AVATAR_BUCKET = 'user-avatars';

/** Per-workspace asset bucket name. */
export function assetBucketName(workspaceId: string): string {
  return `${ASSET_BUCKET_PREFIX}${workspaceId}`;
}

/**
 * Object key layout: workspace_id/asset_id/version_number/filename. The filename
 * is sanitized to a safe key segment; the leading path is opaque and unique per
 * version, so collisions cannot cross assets or workspaces.
 */
export function buildR2Key(input: {
  workspaceId: string;
  assetId: string;
  versionNumber: number;
  filename: string;
}): string {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file';
  return `${input.workspaceId}/${input.assetId}/${input.versionNumber}/${safeName}`;
}

// ---------------------------------------------------------------------------
// R2 (S3-compatible) implementation with AWS SigV4 signing.
// ---------------------------------------------------------------------------

export interface R2StorageEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
}

const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';

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
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

/** Encode a single path segment per RFC 3986 (S3 canonical-URI rules). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDate(now: Date): { full: string; short: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full, short: full.slice(0, 8) };
}

export class R2StorageClient implements StorageClient {
  private readonly host: string;

  constructor(private readonly env: R2StorageEnv) {
    this.host = `${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }

  async ensureBucket(bucket: string, traceId: string): Promise<void> {
    // S3 CreateBucket. R2 returns 200 on create and is happy when the bucket is
    // already owned by us; treat any 2xx and "already owned" as success.
    const res = await this.signedFetch({
      method: 'PUT',
      path: `/${encodeSegment(bucket)}`,
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId,
    });
    if (res.ok) {
      return;
    }
    const text = await res.text();
    if (res.status === 409 || /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(text)) {
      return;
    }
    throw new Error(`R2 ensureBucket failed (${res.status}): ${text}`);
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const res = await this.signedFetch({
      method: 'PUT',
      path: `/${encodeSegment(input.bucket)}/${input.key.split('/').map(encodeSegment).join('/')}`,
      body: input.body,
      contentType: input.contentType,
      traceId: input.traceId,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 putObject failed (${res.status}): ${text}`);
    }
  }

  private async signedFetch(req: {
    method: string;
    path: string;
    body: Uint8Array;
    contentType: string;
    traceId: string;
  }): Promise<Response> {
    const now = new Date();
    const { full, short } = amzDate(now);
    const payloadHash = await sha256Hex(req.body);

    const canonicalHeaders =
      `host:${this.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${full}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      req.method,
      req.path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${short}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, full, scope, await sha256Hex(canonicalRequest)].join('\n');

    const kDate = await hmac(enc.encode(`AWS4${this.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY}`), short);
    const kRegion = await hmac(kDate, REGION);
    const kService = await hmac(kRegion, SERVICE);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex((await hmac(kSigning, stringToSign)).buffer as ArrayBuffer);

    const authorization =
      `${ALGORITHM} Credential=${this.env.CLOUDFLARE_R2_ACCESS_KEY_ID}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = new Headers({
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': full,
      'content-type': req.contentType,
    });

    return fetchWithTrace(
      `https://${this.host}${req.path}`,
      { method: req.method, headers, body: req.body as BodyInit },
      req.traceId,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation for tests. No network, no signing.
// ---------------------------------------------------------------------------

export interface StoredObject {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
}

export class InMemoryStorageClient implements StorageClient {
  readonly buckets = new Set<string>();
  readonly objects = new Map<string, StoredObject>();

  private id(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  ensureBucket(bucket: string): Promise<void> {
    this.buckets.add(bucket);
    return Promise.resolve();
  }

  putObject(input: PutObjectInput): Promise<void> {
    this.buckets.add(input.bucket);
    this.objects.set(this.id(input.bucket, input.key), {
      bucket: input.bucket,
      key: input.key,
      body: new Uint8Array(input.body),
      contentType: input.contentType,
    });
    return Promise.resolve();
  }

  get(bucket: string, key: string): StoredObject | undefined {
    return this.objects.get(this.id(bucket, key));
  }
}
