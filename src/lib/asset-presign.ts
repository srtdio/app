// Presigned-URL access for stored asset versions, via the asset-read Worker.
//
// Contract (src/server/workers/asset-read.ts): POST application/json
//   { asset_version_id } with an `Authorization: Bearer <access_token>` header
//   -> { url, expires_at }. Link versions and versions with no stored bytes are
//   rejected by the Worker (not_a_stored_file); only image/file kinds presign.
//
// The Worker base URL and the access-token reader are injected (PresignDeps) so
// this module stays free of the React / fetch / Sentry import chain and can be
// unit-tested with fakes. PresignCache adds the two properties the grid needs:
// a concurrency cap (a screen of ~200 image cards must not fire 200 presigns at
// once) and a per-version cache reused until just before expiry.
//
// The chat file bubble and viewer add two asset-read modes: a version's
// thumbnail rendition (404 'no_rendition' is cached as absent for the session)
// and a PDF's bytes streamed through the Worker. The viewer never reuses a
// cached link: freshUrl and pdf ask the Worker again on every open.
//
// Fast file links (fileBase set): instead of one presign request per file, the
// cache asks asset-read once a day for a link key (POST {endpoint}/link-key)
// and builds every picture, video and download URL itself:
//   {fileBase}/f/{version}/{thumb|full}?k={key}[&dl=1]
// Those URLs are served through Cloudflare's edge cache with the caller's
// membership checked live on every request, and they stay identical all day so
// the browser reuses what it downloaded. If the key cannot be had, every call
// falls back to the per-file presign path below, unchanged.

import { staticAsset } from '@/lib/static-assets';

/** A successfully minted URL with its absolute expiry in epoch milliseconds. */
export interface PresignedUrl {
  url: string;
  expiresAt: number;
}

export interface PresignDeps {
  /** Asset-read Worker endpoint, or null when unconfigured (presign disabled). */
  endpoint: string | null;
  /** The current session access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Trace-propagating fetch (the app's fetchWithTrace), injected by the caller. */
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Origin that serves fast file links (srtd.io/f/*), no trailing slash; null or
   * absent keeps the per-file presign path.
   */
  fileBase?: string | null;
  /** Where the day's link key outlives the page; null keeps it in memory only. */
  linkKeyStore?: LinkKeyStore | null;
}

/** A day-long link key for fast file links, with its expiry in epoch ms. */
export interface StoredLinkKey {
  key: string;
  expiresAt: number;
}

/** Keeps the link key across app restarts (cleared on sign-out). */
export interface LinkKeyStore {
  load(): StoredLinkKey | null;
  save(key: StoredLinkKey | null): void;
}

/**
 * A link key is good for the rest of its UTC day plus the next one; mint a new
 * one once less than a day is left, so a new day's URLs are used from its start.
 */
const LINK_KEY_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
/** How long a failed link-key request leaves the per-file path in charge. */
const LINK_KEY_RETRY_PAUSE_MS = 60_000;

/** True when a stored link key still has more than a day to run. Pure. */
function isFreshLinkKey(key: StoredLinkKey | null, nowMs: number): key is StoredLinkKey {
  return key !== null && key.expiresAt - nowMs > LINK_KEY_RENEW_BEFORE_MS;
}

/** The link-key endpoint next to the asset-read endpoint. Pure. */
function linkKeyEndpoint(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/link-key`;
}

/** A fast file URL. Pure. */
function fileLinkUrl(input: {
  fileBase: string;
  assetVersionId: string;
  kind: 'thumb' | 'full';
  key: string;
  download?: boolean;
}): string {
  const base = input.fileBase.replace(/\/+$/, '');
  const query = `k=${encodeURIComponent(input.key)}${input.download === true ? '&dl=1' : ''}`;
  return `${base}/f/${encodeURIComponent(input.assetVersionId)}/${input.kind}?${query}`;
}

/** Mint the day's link key from asset-read. Throws PresignError on any failure. */
async function requestLinkKey(deps: PresignDeps): Promise<StoredLinkKey> {
  if (deps.endpoint === null || deps.endpoint === '') {
    throw new PresignError('Asset read endpoint is not configured.', 'unconfigured');
  }
  const token = await deps.getAccessToken();
  if (token === null || token === '') {
    throw new PresignError('No active session.', 'unauthenticated');
  }
  const response = await deps.fetcher(linkKeyEndpoint(deps.endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  });
  if (!response.ok) {
    throw new PresignError(`Link key failed with status ${response.status}.`, 'request_failed');
  }
  const body = (await response.json()) as { key?: unknown; expires_at?: unknown };
  if (typeof body.key !== 'string' || typeof body.expires_at !== 'string') {
    throw new PresignError('Link key response was malformed.', 'request_failed');
  }
  const expiresAt = Date.parse(body.expires_at);
  if (Number.isNaN(expiresAt)) {
    throw new PresignError('Link key response was malformed.', 'request_failed');
  }
  return { key: body.key, expiresAt };
}

export class PresignError extends Error {
  constructor(
    message: string,
    readonly code: 'unconfigured' | 'unauthenticated' | 'request_failed',
  ) {
    super(message);
    this.name = 'PresignError';
  }
}

/** POST one JSON body to asset-read with the caller's bearer token. */
async function postRead(
  deps: PresignDeps,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  if (deps.endpoint === null || deps.endpoint === '') {
    throw new PresignError('Asset read endpoint is not configured.', 'unconfigured');
  }
  const token = await deps.getAccessToken();
  if (token === null || token === '') {
    throw new PresignError('No active session.', 'unauthenticated');
  }
  return deps.fetcher(deps.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
}

/** Read {url, expires_at} off a 2xx presign response. */
async function readPresigned(response: Response): Promise<PresignedUrl> {
  const body = (await response.json()) as { url?: unknown; expires_at?: unknown };
  if (typeof body.url !== 'string' || typeof body.expires_at !== 'string') {
    throw new PresignError('Presign response was malformed.', 'request_failed');
  }
  const expiresAt = Date.parse(body.expires_at);
  return { url: body.url, expiresAt: Number.isNaN(expiresAt) ? Date.now() : expiresAt };
}

/**
 * The version's stored thumbnail, presigned; null when the version has none
 * (204, or the older 404 'no_rendition'). Throws PresignError for every other failure.
 */
export async function requestThumbnailUrl(
  deps: PresignDeps,
  assetVersionId: string,
): Promise<PresignedUrl | null> {
  const response = await postRead(deps, {
    asset_version_id: assetVersionId,
    rendition: 'thumbnail',
  });
  if (response.status === 204) return null;
  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === 'no_rendition') return null;
  }
  if (!response.ok) {
    throw new PresignError(
      `Thumbnail presign failed with status ${response.status}.`,
      'request_failed',
    );
  }
  return readPresigned(response);
}

/**
 * A PDF's bytes through the asset-read Worker (never storage CORS). Resolves
 * to the 2xx Response so the caller reads (or streams) its body; throws
 * PresignError otherwise. Each call is a fresh, authorized read.
 */
export async function fetchPdfStream(
  deps: PresignDeps,
  assetVersionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await postRead(deps, { asset_version_id: assetVersionId, stream: true }, signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PresignError(`PDF stream failed with status ${response.status}.`, 'request_failed');
  }
  return response;
}

/**
 * Mint one presigned URL for an asset version. Throws PresignError for the
 * expected failures (no endpoint, no token, non-2xx) so callers can branch on
 * `.code`; the cache below turns those into a one-shot, non-cached rejection.
 */
export async function requestPresignedUrl(
  deps: PresignDeps,
  assetVersionId: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<PresignedUrl> {
  if (deps.endpoint === null || deps.endpoint === '') {
    throw new PresignError('Asset read endpoint is not configured.', 'unconfigured');
  }
  const token = await deps.getAccessToken();
  if (token === null || token === '') {
    throw new PresignError('No active session.', 'unauthenticated');
  }

  const response = await deps.fetcher(deps.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    // 'inline' is the worker's default; omit it so the inline request body (and
    // thus PresignCache.resolve's wire format) stays byte-for-byte unchanged.
    body: JSON.stringify(
      disposition === 'attachment'
        ? { asset_version_id: assetVersionId, disposition }
        : { asset_version_id: assetVersionId },
    ),
  });
  if (!response.ok) {
    throw new PresignError(`Presign failed with status ${response.status}.`, 'request_failed');
  }

  const body = (await response.json()) as { url?: unknown; expires_at?: unknown };
  if (typeof body.url !== 'string' || typeof body.expires_at !== 'string') {
    throw new PresignError('Presign response was malformed.', 'request_failed');
  }
  const expiresAt = Date.parse(body.expires_at);
  return { url: body.url, expiresAt: Number.isNaN(expiresAt) ? Date.now() : expiresAt };
}

/** Default ceiling on simultaneous presign requests. */
const DEFAULT_CONCURRENCY = 6;
/** Refresh a cached URL this long before it actually expires. */
const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Caches presigned URLs by asset-version id and bounds in-flight presigns to a
 * fixed concurrency. resolve() returns a still-valid cached URL synchronously
 * via the returned promise, dedupes concurrent requests for the same version,
 * and refreshes once the cached URL is within the skew window of expiry.
 */
/** A static file does not expire; a week out keeps refresh timers in setTimeout's range. */
const STATIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where thumbnail URLs outlive the page: the cache loads the still-valid ones
 * when it is made and saves after each new one, so a reopened app paints its
 * small pictures from the browser's own cache with no presign round trip.
 */
export interface ThumbnailUrlStore {
  load(): ReadonlyArray<readonly [string, PresignedUrl]>;
  save(entries: ReadonlyArray<readonly [string, PresignedUrl]>): void;
}

export class PresignCache {
  private readonly cache = new Map<string, PresignedUrl>();
  private readonly inflight = new Map<string, Promise<PresignedUrl>>();
  private readonly waiters: Array<() => void> = [];
  private readonly thumbCache = new Map<string, PresignedUrl>();
  private readonly thumbInflight = new Map<string, Promise<PresignedUrl | null>>();
  /** Versions asset-read answered 'no_rendition' for: absent for the session. */
  private readonly noThumbnail = new Set<string>();
  private active = 0;
  /** The day's link key for fast file links, when in use. */
  private linkKey: StoredLinkKey | null = null;
  private linkKeyInflight: Promise<StoredLinkKey> | null = null;
  /** After a failed link-key request, the per-file path is used until then. */
  private linkKeyRetryAt = 0;

  constructor(
    private readonly deps: PresignDeps,
    private readonly concurrency = DEFAULT_CONCURRENCY,
    private readonly refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
    private readonly thumbStore: ThumbnailUrlStore | null = null,
  ) {
    if (this.fileLinksEnabled()) {
      const stored = deps.linkKeyStore?.load() ?? null;
      if (isFreshLinkKey(stored, Date.now())) this.linkKey = stored;
    }
    if (thumbStore === null) return;
    const now = Date.now();
    for (const [versionId, url] of thumbStore.load()) {
      if (now < url.expiresAt - refreshSkewMs) this.thumbCache.set(versionId, url);
    }
  }

  /** A cached, still-valid URL for synchronous render, or null. */
  peek(assetVersionId: string): PresignedUrl | null {
    const fixed = staticAsset(assetVersionId);
    if (fixed !== undefined) return { url: fixed.full, expiresAt: Date.now() + STATIC_TTL_MS };
    const linked = this.peekFileLink(assetVersionId, 'full');
    if (linked !== null) return linked;
    const hit = this.cache.get(assetVersionId);
    if (hit !== undefined && Date.now() < hit.expiresAt - this.refreshSkewMs) return hit;
    return null;
  }

  /**
   * The thumbnail rendition's URL for a version, cached until 60 s before it
   * expires; a version with none is remembered as absent for the session.
   * Bounded by the same concurrency cap; concurrent asks share one request.
   */
  thumbnail(assetVersionId: string): Promise<PresignedUrl | null> {
    const fixedThumb = staticAsset(assetVersionId);
    if (fixedThumb !== undefined) {
      return Promise.resolve({ url: fixedThumb.thumb, expiresAt: Date.now() + STATIC_TTL_MS });
    }
    if (this.noThumbnail.has(assetVersionId)) return Promise.resolve(null);
    const cached = this.peekThumbnail(assetVersionId);
    if (cached !== null) return Promise.resolve(cached);
    // Fast file links: the small copy's URL is built here, no request per file.
    // A version without one answers 404 and the picture falls back on its error.
    if (this.fileLinksEnabled()) {
      return this.withFileLink(assetVersionId, 'thumb', () =>
        this.presignThumbnail(assetVersionId),
      );
    }
    return this.presignThumbnail(assetVersionId);
  }

  /** The per-file thumbnail presign (the path before fast file links). */
  private presignThumbnail(assetVersionId: string): Promise<PresignedUrl | null> {
    const cached = this.legacyThumbnail(assetVersionId);
    if (cached !== null) return Promise.resolve(cached);
    const existing = this.thumbInflight.get(assetVersionId);
    if (existing !== undefined) return existing;
    const promise = this.withSlot(() => requestThumbnailUrl(this.deps, assetVersionId))
      .then((url) => {
        if (url === null) this.noThumbnail.add(assetVersionId);
        else {
          this.thumbCache.set(assetVersionId, url);
          this.thumbStore?.save([...this.thumbCache]);
        }
        return url;
      })
      .finally(() => {
        this.thumbInflight.delete(assetVersionId);
      });
    this.thumbInflight.set(assetVersionId, promise);
    return promise;
  }

  /** A cached, still-valid thumbnail URL for synchronous render, or null. */
  peekThumbnail(assetVersionId: string): PresignedUrl | null {
    const fixedThumb = staticAsset(assetVersionId);
    if (fixedThumb !== undefined)
      return { url: fixedThumb.thumb, expiresAt: Date.now() + STATIC_TTL_MS };
    if (this.noThumbnail.has(assetVersionId)) return null;
    const linked = this.peekFileLink(assetVersionId, 'thumb');
    if (linked !== null) return linked;
    return this.legacyThumbnail(assetVersionId);
  }

  /** A still-valid presigned thumbnail from the per-file path, or null. */
  private legacyThumbnail(assetVersionId: string): PresignedUrl | null {
    const hit = this.thumbCache.get(assetVersionId);
    if (hit !== undefined && Date.now() < hit.expiresAt - this.refreshSkewMs) return hit;
    return null;
  }

  /** A fresh URL every call (never the cache): the viewer's video and Download links. */
  freshUrl(
    assetVersionId: string,
    disposition: 'inline' | 'attachment' = 'inline',
  ): Promise<PresignedUrl> {
    if (this.fileLinksEnabled()) {
      return this.withFileLink(
        assetVersionId,
        'full',
        () => requestPresignedUrl(this.deps, assetVersionId, disposition),
        disposition === 'attachment',
      );
    }
    return requestPresignedUrl(this.deps, assetVersionId, disposition);
  }

  /**
   * A presigned storage URL, always minted per file (never a fast file link).
   * For server-side readers that only accept the storage host: the voice-note
   * transcriber fetches the audio itself and refuses any other host.
   */
  storageUrl(assetVersionId: string): Promise<PresignedUrl> {
    return requestPresignedUrl(this.deps, assetVersionId);
  }

  /** A PDF's bytes through the Worker, fresh on every call. */
  pdf(assetVersionId: string, signal?: AbortSignal): Promise<Response> {
    return fetchPdfStream(this.deps, assetVersionId, signal);
  }

  /** Resolve a presigned URL, using the cache and respecting the concurrency cap. */
  resolve(assetVersionId: string): Promise<PresignedUrl> {
    const cached = this.peek(assetVersionId);
    if (cached !== null) return Promise.resolve(cached);
    if (this.fileLinksEnabled()) {
      return this.withFileLink(assetVersionId, 'full', () => this.presignFull(assetVersionId));
    }
    return this.presignFull(assetVersionId);
  }

  /** The per-file presign (the path before fast file links). */
  private presignFull(assetVersionId: string): Promise<PresignedUrl> {
    const hit = this.cache.get(assetVersionId);
    if (hit !== undefined && Date.now() < hit.expiresAt - this.refreshSkewMs) {
      return Promise.resolve(hit);
    }
    const existing = this.inflight.get(assetVersionId);
    if (existing !== undefined) return existing;

    const promise = this.withSlot(() => requestPresignedUrl(this.deps, assetVersionId))
      .then((url) => {
        this.cache.set(assetVersionId, url);
        return url;
      })
      .finally(() => {
        this.inflight.delete(assetVersionId);
      });
    this.inflight.set(assetVersionId, promise);
    return promise;
  }

  /**
   * Drop the cached URL for a version and presign it again (a voice note whose
   * playback failed). A request already in flight is shared, not doubled.
   */
  refresh(assetVersionId: string): Promise<PresignedUrl> {
    this.cache.delete(assetVersionId);
    // A failed playback may mean the link key itself was refused: mint a new one.
    if (this.fileLinksEnabled()) this.dropLinkKey();
    return this.resolve(assetVersionId);
  }

  /** Whether fast file links are configured. */
  private fileLinksEnabled(): boolean {
    const base = this.deps.fileBase ?? null;
    return base !== null && base !== '' && this.deps.endpoint !== null && this.deps.endpoint !== '';
  }

  /** A fast file URL from the held link key, or null when none is held. */
  private peekFileLink(assetVersionId: string, kind: 'thumb' | 'full'): PresignedUrl | null {
    if (!this.fileLinksEnabled()) return null;
    const key = this.linkKey;
    if (!isFreshLinkKey(key, Date.now())) return null;
    return {
      url: fileLinkUrl({ fileBase: this.deps.fileBase ?? '', assetVersionId, kind, key: key.key }),
      expiresAt: key.expiresAt,
    };
  }

  /**
   * Build a fast file URL once the day's link key is held (minting it on first
   * use; concurrent callers share one request). When the key cannot be had,
   * fall back to the per-file presign path so pictures still load.
   */
  private async withFileLink<T extends PresignedUrl | null>(
    assetVersionId: string,
    kind: 'thumb' | 'full',
    fallback: () => Promise<T>,
    download = false,
  ): Promise<PresignedUrl | T> {
    let key: StoredLinkKey;
    try {
      key = await this.currentLinkKey();
    } catch (error) {
      if (error instanceof PresignError && error.code === 'unauthenticated') throw error;
      return fallback();
    }
    return {
      url: fileLinkUrl({
        fileBase: this.deps.fileBase ?? '',
        assetVersionId,
        kind,
        key: key.key,
        download,
      }),
      expiresAt: key.expiresAt,
    };
  }

  /** The held link key when fresh, else one new request shared by every caller. */
  private currentLinkKey(): Promise<StoredLinkKey> {
    const held = this.linkKey;
    if (isFreshLinkKey(held, Date.now())) return Promise.resolve(held);
    if (this.linkKeyInflight !== null) return this.linkKeyInflight;
    // A recent failure: do not ask again per file (that would double every
    // request); the per-file path carries on until the pause ends.
    if (Date.now() < this.linkKeyRetryAt) {
      return Promise.reject(new PresignError('Link key paused after a failure.', 'request_failed'));
    }
    const promise = requestLinkKey(this.deps)
      .then((key) => {
        this.linkKey = key;
        this.linkKeyRetryAt = 0;
        this.deps.linkKeyStore?.save(key);
        return key;
      })
      .catch((error: unknown) => {
        if (!(error instanceof PresignError && error.code === 'unauthenticated')) {
          this.linkKeyRetryAt = Date.now() + LINK_KEY_RETRY_PAUSE_MS;
        }
        throw error;
      })
      .finally(() => {
        this.linkKeyInflight = null;
      });
    this.linkKeyInflight = promise;
    return promise;
  }

  /** Forget the held link key (here and on the device). */
  private dropLinkKey(): void {
    this.linkKey = null;
    this.deps.linkKeyStore?.save(null);
  }

  /** Run `fn` once a concurrency slot is free, releasing it (and the next waiter) after. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next !== undefined) next();
    }
  }
}
