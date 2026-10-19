// Object storage boundary for R2.
//
// One bucket per workspace, created lazily on first upload. The bucket name is a
// readable, permanent value stored on workspaces.asset_bucket (set by a DB
// trigger and immutable thereafter); callers resolve it from that column and
// pass it in - it is never computed from the workspace id here. The pipeline
// depends only on the StorageClient interface, so tests
// inject an in-memory implementation and never touch the network. The R2
// implementation talks to the S3-compatible API with SigV4 signing, using the
// R2 access-key credentials from env - no service binding, because buckets are
// created at runtime.
//
// This package is runtime-neutral: it imports nothing app-specific. The traced
// fetch is supplied by the caller via the constructor so trace propagation is
// preserved without depending on the app's Vite-bound fetch wrapper. The app
// passes its fetchWithTrace; the Node ETL passes its own traced fetch.

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
  /** True if an object already exists at bucket/key. Lets a resumed run skip re-uploading bytes. */
  objectExists(bucket: string, key: string, traceId: string): Promise<boolean>;
}

/** One finished part of a multipart upload, as R2 reports it. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * R2 multipart uploads plus the whole-object read and delete the resumable
 * upload path needs to hand the assembled bytes to the upload pipeline. Kept
 * apart from StorageClient so existing StorageClient fakes stay valid.
 */
export interface MultipartStorage {
  /** Start a multipart upload; returns R2's upload id. */
  createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
    traceId: string;
  }): Promise<string>;
  /** Store one part; returns its ETag. */
  uploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
    traceId: string;
  }): Promise<string>;
  /** The parts R2 already holds, by ascending part number; null when the upload is gone. */
  listParts(input: {
    bucket: string;
    key: string;
    uploadId: string;
    traceId: string;
  }): Promise<UploadedPart[] | null>;
  /** Assemble the parts into the object. False when the upload is gone (completed or aborted). */
  completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: readonly { partNumber: number; etag: string }[];
    traceId: string;
  }): Promise<boolean>;
  /** Drop an upload and its parts. Idempotent: an unknown upload is not an error. */
  abortMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    traceId: string;
  }): Promise<void>;
  /** The object's bytes, or null when absent. */
  getObject(bucket: string, key: string, traceId: string): Promise<Uint8Array | null>;
  /** Delete an object. Idempotent. */
  deleteObject(bucket: string, key: string, traceId: string): Promise<void>;
}

/** One object in a bucket listing. */
export interface ListedObject {
  key: string;
  size: number;
}

/** One page of a bucket listing; nextCursor is null on the last page. */
export interface ObjectPage {
  objects: ListedObject[];
  nextCursor: string | null;
}

/**
 * Whole-bucket operations for the workspace purge: page through every key, then
 * drop the emptied bucket. Kept apart from StorageClient so existing fakes stay
 * valid.
 */
export interface BucketStorage {
  /** One page of keys (at most `limit`, R2 caps at 1000), resumed from `cursor`. */
  listObjects(input: {
    bucket: string;
    cursor?: string | null;
    limit?: number;
    traceId: string;
  }): Promise<ObjectPage>;
  /** Delete an empty bucket. Idempotent: a missing bucket is not an error. */
  deleteBucket(bucket: string, traceId: string): Promise<void>;
}

/** Text of the first <tag>...</tag> in an S3 XML body, or null. */
function xmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match === null ? null : (match[1] ?? null);
}

/** Undo the five XML entities S3 escapes (ETags carry &quot;). */
function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse a ListParts body into parts sorted by part number. */
export function parseListPartsXml(xml: string): UploadedPart[] {
  const parts: UploadedPart[] = [];
  for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const body = match[1] ?? '';
    const partNumber = Number.parseInt(xmlTag(body, 'PartNumber') ?? '', 10);
    const etag = xmlTag(body, 'ETag');
    const size = Number.parseInt(xmlTag(body, 'Size') ?? '', 10);
    if (!Number.isInteger(partNumber) || etag === null || !Number.isFinite(size)) continue;
    parts.push({ partNumber, etag: xmlUnescape(etag), size });
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/** Parse a ListObjectsV2 body into its objects and continuation token. */
export function parseListObjectsXml(xml: string): ObjectPage {
  const objects: ListedObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = match[1] ?? '';
    const key = xmlTag(body, 'Key');
    const size = Number.parseInt(xmlTag(body, 'Size') ?? '', 10);
    if (key === null) continue;
    objects.push({ key: xmlUnescape(key), size: Number.isFinite(size) ? size : 0 });
  }
  const truncated = xmlTag(xml, 'IsTruncated') === 'true';
  const token = xmlTag(xml, 'NextContinuationToken');
  return {
    objects,
    nextCursor: truncated && token !== null && token !== '' ? xmlUnescape(token) : null,
  };
}

/** The CompleteMultipartUpload request body. */
export function completeMultipartXml(
  parts: readonly { partNumber: number; etag: string }[],
): string {
  const items = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`,
    )
    .join('');
  return `<CompleteMultipartUpload>${items}</CompleteMultipartUpload>`;
}

/**
 * A fetch that attaches the X-Trace-Id header. Matches the signature of the
 * app's fetchWithTrace so callers can pass it directly; the package defines the
 * type locally to avoid importing anything app-specific.
 */
export type TracedFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
  traceId?: string,
) => Promise<Response>;

export const AVATAR_BUCKET = 'user-avatars';

/**
 * Folder segment for an asset kind. The bucket is already per-workspace, so the
 * key groups by kind rather than repeating the workspace id. Pluralized for the
 * common media kinds; every other file-bearing kind (audio, pdf, spreadsheet,
 * presentation, ...) falls back to its own kind string. Link kinds never reach
 * this path - they carry no bytes and have no R2 key.
 */
const KIND_FOLDER: Readonly<Record<string, string>> = {
  image: 'images',
  video: 'videos',
  document: 'docs',
};

function kindFolder(kind: string): string {
  return KIND_FOLDER[kind] ?? kind;
}

/**
 * Object key layout within a workspace bucket: {kindFolder}/{asset_id}/v{n}-{filename}.
 * The filename is sanitized to a safe key segment; the asset id plus version
 * prefix make every key unique per version, so collisions cannot cross assets.
 */
export function buildR2Key(input: {
  kind: string;
  assetId: string;
  versionNumber: number;
  filename: string;
}): string {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file';
  return `${kindFolder(input.kind)}/${input.assetId}/v${input.versionNumber}-${safeName}`;
}

/**
 * Object key of a version's thumbnail rendition, next to the version's own
 * bytes: {kindFolder}/{asset_id}/v{n}-thumb.jpg. Additive: buildR2Key is
 * unchanged, so existing keys never move.
 */
export function buildThumbnailKey(input: {
  kind: string;
  assetId: string;
  versionNumber: number;
}): string {
  return `${kindFolder(input.kind)}/${input.assetId}/v${input.versionNumber}-thumb.jpg`;
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

/**
 * Drop control characters, double quotes, and backslashes so the value can sit
 * safely inside a quoted Content-Disposition filename. Done char-by-char rather
 * than with a control-character regex so it stays lint-clean.
 */
function sanitizeFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '"' || ch === '\\') continue;
    out += ch;
  }
  return out.trim();
}

/** RFC 5987 ext-value encoding of a UTF-8 string (for filename*=). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (_full, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * A Content-Disposition: attachment value with a sanitized ASCII fallback and an
 * RFC 5987 filename* for the full UTF-8 name. The whole string is later RFC 3986
 * percent-encoded as a query value, so it is signed verbatim.
 */
function attachmentDisposition(filename: string): string {
  const clean = sanitizeFilename(filename) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
}

/** The S3 path of an object: /{bucket}/{key segments}, each RFC 3986-encoded. */
function objectPath(bucket: string, key: string): string {
  return `/${encodeSegment(bucket)}/${key.split('/').map(encodeSegment).join('/')}`;
}

export class R2StorageClient implements StorageClient, MultipartStorage, BucketStorage {
  private readonly host: string;

  constructor(
    private readonly env: R2StorageEnv,
    private readonly tracedFetch: TracedFetch,
  ) {
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

  async objectExists(bucket: string, key: string, traceId: string): Promise<boolean> {
    // S3 HEAD object: 200 means the bytes are already present, 404 means absent.
    // Any other status is unexpected and surfaced like putObject/ensureBucket.
    const res = await this.signedFetch({
      method: 'HEAD',
      path: `/${encodeSegment(bucket)}/${key.split('/').map(encodeSegment).join('/')}`,
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId,
    });
    if (res.status === 200) {
      return true;
    }
    if (res.status === 404) {
      return false;
    }
    const text = await res.text();
    throw new Error(`R2 objectExists failed (${res.status}): ${text}`);
  }

  async createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
    traceId: string;
  }): Promise<string> {
    const res = await this.signedFetch({
      method: 'POST',
      path: objectPath(input.bucket, input.key),
      query: [['uploads', '']],
      body: new Uint8Array(0),
      contentType: input.contentType,
      traceId: input.traceId,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`R2 createMultipartUpload failed (${res.status}): ${text}`);
    }
    const uploadId = xmlTag(text, 'UploadId');
    if (uploadId === null || uploadId === '') {
      throw new Error('R2 createMultipartUpload returned no UploadId');
    }
    return xmlUnescape(uploadId);
  }

  async uploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
    traceId: string;
  }): Promise<string> {
    const res = await this.signedFetch({
      method: 'PUT',
      path: objectPath(input.bucket, input.key),
      query: [
        ['partNumber', String(input.partNumber)],
        ['uploadId', input.uploadId],
      ],
      body: input.body,
      contentType: 'application/octet-stream',
      traceId: input.traceId,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 uploadPart failed (${res.status}): ${text}`);
    }
    const etag = res.headers.get('ETag');
    if (etag === null || etag === '') {
      throw new Error('R2 uploadPart returned no ETag');
    }
    return etag;
  }

  async listParts(input: {
    bucket: string;
    key: string;
    uploadId: string;
    traceId: string;
  }): Promise<UploadedPart[] | null> {
    const res = await this.signedFetch({
      method: 'GET',
      path: objectPath(input.bucket, input.key),
      query: [['uploadId', input.uploadId]],
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId: input.traceId,
    });
    const text = await res.text();
    if (res.status === 404 || /NoSuchUpload/.test(text)) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`R2 listParts failed (${res.status}): ${text}`);
    }
    return parseListPartsXml(text);
  }

  async completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: readonly { partNumber: number; etag: string }[];
    traceId: string;
  }): Promise<boolean> {
    const res = await this.signedFetch({
      method: 'POST',
      path: objectPath(input.bucket, input.key),
      query: [['uploadId', input.uploadId]],
      body: enc.encode(completeMultipartXml(input.parts)),
      contentType: 'application/xml',
      traceId: input.traceId,
    });
    const text = await res.text();
    // S3 can answer 200 with an <Error> body when assembly fails late.
    if (res.ok && !/<Error>/.test(text)) {
      return true;
    }
    if (res.status === 404 || /NoSuchUpload/.test(text)) {
      return false;
    }
    throw new Error(`R2 completeMultipartUpload failed (${res.status}): ${text}`);
  }

  async abortMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    traceId: string;
  }): Promise<void> {
    const res = await this.signedFetch({
      method: 'DELETE',
      path: objectPath(input.bucket, input.key),
      query: [['uploadId', input.uploadId]],
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId: input.traceId,
    });
    if (res.ok || res.status === 404) {
      return;
    }
    const text = await res.text();
    if (/NoSuchUpload/.test(text)) {
      return;
    }
    throw new Error(`R2 abortMultipartUpload failed (${res.status}): ${text}`);
  }

  async getObject(bucket: string, key: string, traceId: string): Promise<Uint8Array | null> {
    const res = await this.signedFetch({
      method: 'GET',
      path: objectPath(bucket, key),
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId,
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 getObject failed (${res.status}): ${text}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteObject(bucket: string, key: string, traceId: string): Promise<void> {
    const res = await this.signedFetch({
      method: 'DELETE',
      path: objectPath(bucket, key),
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId,
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`R2 deleteObject failed (${res.status}): ${text}`);
    }
  }

  async listObjects(input: {
    bucket: string;
    cursor?: string | null;
    limit?: number;
    traceId: string;
  }): Promise<ObjectPage> {
    const query: Array<[string, string]> = [
      ['list-type', '2'],
      ['max-keys', String(Math.min(Math.max(input.limit ?? 1000, 1), 1000))],
    ];
    if (input.cursor !== undefined && input.cursor !== null) {
      query.push(['continuation-token', input.cursor]);
    }
    const res = await this.signedFetch({
      method: 'GET',
      path: `/${encodeSegment(input.bucket)}`,
      query,
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId: input.traceId,
    });
    const text = await res.text();
    if (res.status === 404 || /NoSuchBucket/.test(text)) {
      return { objects: [], nextCursor: null };
    }
    if (!res.ok) {
      throw new Error(`R2 listObjects failed (${res.status}): ${text}`);
    }
    return parseListObjectsXml(text);
  }

  async deleteBucket(bucket: string, traceId: string): Promise<void> {
    const res = await this.signedFetch({
      method: 'DELETE',
      path: `/${encodeSegment(bucket)}`,
      body: new Uint8Array(0),
      contentType: 'application/octet-stream',
      traceId,
    });
    if (res.ok || res.status === 404) {
      return;
    }
    const text = await res.text();
    if (/NoSuchBucket/.test(text)) {
      return;
    }
    throw new Error(`R2 deleteBucket failed (${res.status}): ${text}`);
  }

  /**
   * Mint a query-string SigV4 presigned GET URL the browser can fetch directly.
   * No request is sent here - this only signs - so the caller never proxies the
   * object bytes. Reuses the same SigV4 primitives as the PUT path; the payload
   * is unsigned (standard for presigned URLs). Valid for `expiresInSeconds`.
   */
  async presignGetUrl(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    /**
     * When set, the signed URL carries response-content-disposition=attachment
     * with this filename, so the browser saves the object instead of rendering
     * it inline. Omitted = inline; the signing path is then byte-identical to
     * before, so image/video rendering is unaffected.
     */
    downloadFilename?: string;
    /**
     * Sign as of this instant instead of now. A caller that floors it to a
     * window gets the same URL for every request in that window, so the
     * browser's HTTP cache can serve the object again (expiry counts from it).
     */
    signedAt?: Date;
    /** When set, the signed URL carries response-cache-control with this value. */
    cacheControl?: string;
  }): Promise<string> {
    const now = input.signedAt ?? new Date();
    const { full, short } = amzDate(now);
    const canonicalUri = `/${encodeSegment(input.bucket)}/${input.key
      .split('/')
      .map(encodeSegment)
      .join('/')}`;
    const scope = `${short}/${REGION}/${SERVICE}/aws4_request`;
    const credential = `${this.env.CLOUDFLARE_R2_ACCESS_KEY_ID}/${scope}`;

    // Query params must be sorted by key; values RFC 3986-encoded (encodeSegment
    // also percent-encodes the '/' in Credential, as SigV4 requires). The
    // optional response-content-disposition is a signed override and sorts after
    // every X-Amz-* key ('X' < 'r' in byte order), so it is appended last.
    const query: Array<[string, string]> = [
      ['X-Amz-Algorithm', ALGORITHM],
      ['X-Amz-Credential', credential],
      ['X-Amz-Date', full],
      ['X-Amz-Expires', String(input.expiresInSeconds)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    // response-cache-control sorts before response-content-disposition ('a' < 'o').
    if (input.cacheControl !== undefined) {
      query.push(['response-cache-control', input.cacheControl]);
    }
    if (input.downloadFilename !== undefined) {
      query.push(['response-content-disposition', attachmentDisposition(input.downloadFilename)]);
    }
    const canonicalQuery = query
      .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
      .join('&');

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery,
      `host:${this.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [ALGORITHM, full, scope, await sha256Hex(canonicalRequest)].join('\n');
    const kSigning = await this.deriveSigningKey(short);
    const signature = toHex((await hmac(kSigning, stringToSign)).buffer as ArrayBuffer);

    return `https://${this.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  /** Derive the SigV4 date-scoped signing key. Shared by the PUT and presign paths. */
  private async deriveSigningKey(short: string): Promise<Uint8Array> {
    const kDate = await hmac(enc.encode(`AWS4${this.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY}`), short);
    const kRegion = await hmac(kDate, REGION);
    const kService = await hmac(kRegion, SERVICE);
    return hmac(kService, 'aws4_request');
  }

  private async signedFetch(req: {
    method: string;
    path: string;
    /** Query parameters; signed in SigV4 canonical (sorted, RFC 3986) form. */
    query?: ReadonlyArray<readonly [string, string]>;
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

    const scope = `${short}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, full, scope, await sha256Hex(canonicalRequest)].join('\n');

    const kSigning = await this.deriveSigningKey(short);
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

    // GET/HEAD must not carry a body: Node's fetch rejects them with "Request
    // with GET/HEAD method cannot have body." The SigV4 signature above already
    // hashed the (empty) payload, so x-amz-content-sha256 stays correct; only the
    // literal fetch body is dropped for bodyless methods. PUT is unaffected.
    const sendsBody = req.method !== 'GET' && req.method !== 'HEAD';
    const init: RequestInit = sendsBody
      ? { method: req.method, headers, body: req.body as BodyInit }
      : { method: req.method, headers };
    const url = `https://${this.host}${req.path}${canonicalQuery === '' ? '' : `?${canonicalQuery}`}`;
    return this.tracedFetch(url, init, req.traceId);
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

  objectExists(bucket: string, key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(this.id(bucket, key)));
  }

  get(bucket: string, key: string): StoredObject | undefined {
    return this.objects.get(this.id(bucket, key));
  }
}

/** In-memory multipart storage for tests; extends the plain in-memory client. */
export class InMemoryMultipartStorage
  extends InMemoryStorageClient
  implements MultipartStorage, BucketStorage
{
  readonly uploads = new Map<
    string,
    { bucket: string; key: string; contentType: string; parts: Map<number, Uint8Array> }
  >();
  private nextUpload = 1;

  createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
  }): Promise<string> {
    const uploadId = `upload-${this.nextUpload++}`;
    this.uploads.set(uploadId, {
      bucket: input.bucket,
      key: input.key,
      contentType: input.contentType,
      parts: new Map(),
    });
    return Promise.resolve(uploadId);
  }

  private upload(bucket: string, key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    return upload !== undefined && upload.bucket === bucket && upload.key === key
      ? upload
      : undefined;
  }

  uploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
  }): Promise<string> {
    const upload = this.upload(input.bucket, input.key, input.uploadId);
    if (upload === undefined) return Promise.reject(new Error('NoSuchUpload'));
    upload.parts.set(input.partNumber, new Uint8Array(input.body));
    return Promise.resolve(`"etag-${input.partNumber}-${input.body.byteLength}"`);
  }

  listParts(input: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<UploadedPart[] | null> {
    const upload = this.upload(input.bucket, input.key, input.uploadId);
    if (upload === undefined) return Promise.resolve(null);
    return Promise.resolve(
      [...upload.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([partNumber, body]) => ({
          partNumber,
          etag: `"etag-${partNumber}-${body.byteLength}"`,
          size: body.byteLength,
        })),
    );
  }

  completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: readonly { partNumber: number; etag: string }[];
  }): Promise<boolean> {
    const upload = this.upload(input.bucket, input.key, input.uploadId);
    if (upload === undefined) return Promise.resolve(false);
    const chunks = [...input.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => upload.parts.get(p.partNumber) ?? new Uint8Array(0));
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.uploads.delete(input.uploadId);
    this.objects.set(`${input.bucket}/${input.key}`, {
      bucket: input.bucket,
      key: input.key,
      body,
      contentType: upload.contentType,
    });
    return Promise.resolve(true);
  }

  abortMultipartUpload(input: { uploadId: string }): Promise<void> {
    this.uploads.delete(input.uploadId);
    return Promise.resolve();
  }

  getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.get(bucket, key)?.body ?? null);
  }

  deleteObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
    return Promise.resolve();
  }

  /** Keys in byte order; the cursor is the last key of the previous page. */
  listObjects(input: {
    bucket: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<ObjectPage> {
    const limit = Math.min(Math.max(input.limit ?? 1000, 1), 1000);
    const cursor = input.cursor ?? null;
    const keys = [...this.objects.values()]
      .filter((o) => o.bucket === input.bucket && (cursor === null || o.key > cursor))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const page = keys.slice(0, limit);
    const last = page[page.length - 1];
    return Promise.resolve({
      objects: page.map((o) => ({ key: o.key, size: o.body.byteLength })),
      nextCursor: keys.length > limit && last !== undefined ? last.key : null,
    });
  }

  /** Mirrors R2: a bucket that still holds objects cannot be deleted. */
  deleteBucket(bucket: string): Promise<void> {
    if ([...this.objects.values()].some((o) => o.bucket === bucket)) {
      return Promise.reject(new Error('BucketNotEmpty'));
    }
    this.buckets.delete(bucket);
    return Promise.resolve();
  }
}
