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
export class PresignCache {
  private readonly cache = new Map<string, PresignedUrl>();
  private readonly inflight = new Map<string, Promise<PresignedUrl>>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(
    private readonly deps: PresignDeps,
    private readonly concurrency = DEFAULT_CONCURRENCY,
    private readonly refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
  ) {}

  /** A cached, still-valid URL for synchronous render, or null. */
  peek(assetVersionId: string): PresignedUrl | null {
    const hit = this.cache.get(assetVersionId);
    if (hit !== undefined && Date.now() < hit.expiresAt - this.refreshSkewMs) return hit;
    return null;
  }

  /** Resolve a presigned URL, using the cache and respecting the concurrency cap. */
  resolve(assetVersionId: string): Promise<PresignedUrl> {
    const cached = this.peek(assetVersionId);
    if (cached !== null) return Promise.resolve(cached);

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
