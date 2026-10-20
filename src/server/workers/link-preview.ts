/// <reference types="@cloudflare/workers-types" />
// Cloudflare Worker: link previews.
//
// GET /preview?url=<link>  (Bearer Supabase JWT, CORS like the other Workers)
//   -> { type: 'full' | 'text' | 'login' | 'bare' | 'unsafe', ... } (LinkPreview)
// GET /image?url=<page link>
//   -> the og:image of that page's CACHED preview, nothing else.
//
// Safety, in order:
//   1. checkLink (src/lib/links/safety.ts, shared with the browser) runs before
//      anything else; an unsafe link is answered without any fetch.
//   2. Redirects are followed by hand (max 5) and checkLink re-runs on EVERY
//      hop, so a link can never be bounced to a private, loopback, IP-literal
//      or plain-http host. Workers' own fetch cannot reach private networks
//      either; this is the in-code layer on top.
//   3. No Authorization, cookies or inbound headers are ever sent onward; only
//      a fixed User-Agent/Accept plus our own X-Trace-Id. Set-Cookie answers are
//      dropped with the response.
//   4. Only text/html bodies are read, streamed and cut at </head> or 512 KiB,
//      within one 5 s budget for the whole chain. Every remote string is
//      entity-decoded, tag-stripped, whitespace-collapsed and length-capped;
//      the JSON carries plain text only, never HTML.
//   5. /image is not an open proxy: it takes a PAGE url, looks up that page's
//      cached preview and fetches only the image URL recorded there, with the
//      same hop checks, raster types only (no SVG), 2 MiB max.
//
// /image takes no Authorization: an <img> cannot send one. It can only return
// images that an authenticated /preview already chose to cache.
//
// Cache: the Workers Cache API (caches.default), keyed by the normalized URL
// (lowercased host, no fragment, tracking params removed). Success 24 h,
// failure 1 h, unsafe 24 h. No KV, no D1, no schema. The Cache API is local to
// one Cloudflare data centre (and inert on workers.dev), so a small per-isolate
// memory layer sits in front of it.
//
// Rate cap: 120 /preview calls per user per 10 minutes, counted in isolate
// memory (an isolate is per data centre and short-lived, so this is a soft cap;
// a hard global cap would need a Durable Object or KV, which is out of scope).
//
// Actor: the verified JWT `sub` only, via asset-read's verifyCaller.

import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
import { isPreviewOrigin } from '@/server/preview-origin';
import {
  checkLink,
  hostLabel,
  isShortener,
  linkBase,
  normalizeUrl,
  type LinkBase,
  type Reason,
} from '@/lib/links/safety';

export { normalizeUrl };
import { getSupabaseJwks, verifyCaller } from './asset-read';

export interface LinkPreviewEnv {
  /** Project URL; its published JWKS verifies caller tokens. Not a secret. */
  SUPABASE_URL: string;
  /** Comma-separated browser origins allowed to call /preview cross-origin. */
  ALLOWED_ORIGINS?: string;
}

/** What /preview answers. Text fields are plain text, already capped. */
export type LinkPreview =
  | (PreviewBase & {
      type: 'full' | 'text';
      title: string;
      description: string | null;
      siteName: string | null;
      /** True for video pages (YouTube, Vimeo, reels, og:type video.*). */
      video: boolean;
      /** Video length in whole seconds when the page states it. */
      durationSeconds: number | null;
    })
  | (PreviewBase & { type: 'login' | 'bare' })
  | { type: 'unsafe'; domain: string; reasons: Reason[] };

export type PreviewBase = LinkBase;

/** The cached record: the public preview plus the image URL /image may fetch. */
interface CachedPreview {
  preview: LinkPreview;
  imageUrl: string | null;
}

export const USER_AGENT = 'SortedLinkPreview/1.0 (+https://srtd.io)';
export const MAX_REDIRECTS = 5;
export const FETCH_BUDGET_MS = 5_000;
export const MAX_HEAD_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const TITLE_CAP = 200;
export const DESCRIPTION_CAP = 400;
export const RATE_LIMIT = 120;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_URL_LENGTH = 2048;
/** In-memory cache budget per isolate: previews plus a few images, far below 128 MB. */
export const MEMORY_LAYER_BYTES = 16 * 1024 * 1024;

const TTL_SUCCESS_S = 86_400;
const TTL_FAILURE_S = 3_600;
const TTL_UNSAFE_S = 86_400;
const TTL_IMAGE_S = 86_400;

const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const CACHE_ORIGIN = 'https://link-preview.cache';

const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io'] as const;
const CORS_MAX_AGE_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// URL helpers

const LOGIN_PATH =
  /(^|\/)(log-?in|sign-?in|signin|sign_in|auth|sso|oauth2?|servicelogin)(\/|$|\.|\?)/i;
const LOGIN_HOST = /^(accounts?|login|signin|auth|sso)\./i;

/** True when a redirect target looks like a sign-in page. */
export function isLoginUrl(url: URL): boolean {
  return LOGIN_HOST.test(url.hostname) || LOGIN_PATH.test(url.pathname);
}

// ---------------------------------------------------------------------------
// Head parser (no dependency). Reads <meta> and <title> as text only.

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '\u2026',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  rarr: '\u2192',
  laquo: '\u00ab',
  raquo: '\u00bb',
};

/** Decode HTML entities (named subset + numeric). Unknown names stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code >= 0xd800 && code <= 0xdfff) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Make one remote string safe to show as text: decode entities, drop anything
 * tag-shaped (also after decoding, so &lt;b&gt; never comes back as markup),
 * drop control characters, collapse whitespace, cap by code points.
 */
export function cleanText(raw: string, cap: number): string {
  const decoded = decodeEntities(raw.replace(/<[^>]*>/g, ' '));
  const text = decoded
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(text);
  return points.length > cap
    ? `${points
        .slice(0, cap - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;

/** Every <meta> on the page as a lowercased key (property/name/itemprop) -> content. */
export interface HeadData {
  meta: Map<string, string>;
  title: string | null;
}

export function parseHead(html: string): HeadData {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ');
  const meta = new Map<string, string>();
  for (const tag of cleaned.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const m of tag[0].matchAll(ATTR)) {
      const name = (m[1] ?? '').toLowerCase();
      attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
    }
    const key = attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop');
    const content = attrs.get('content');
    if (key === undefined || content === undefined) continue;
    const lower = key.trim().toLowerCase();
    // First one wins, like every unfurler.
    if (!meta.has(lower)) meta.set(lower, content);
  }
  const titleMatch = cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return { meta, title: titleMatch?.[1] ?? null };
}

/** ISO 8601 duration (PT1H2M14S) or plain seconds -> whole seconds. */
export function parseDuration(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Math.round(Number(text));
    return n > 0 && n < 864_000 ? n : null;
  }
  const iso = text.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso === null || text === 'P' || text === 'PT') return null;
  const [, d, h, m, s] = iso;
  const total =
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  const n = Math.round(total);
  return n > 0 && n < 864_000 ? n : null;
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/;

function isVideoPage(url: URL, ogType: string | undefined): boolean {
  if (ogType !== undefined && ogType.trim().toLowerCase().startsWith('video')) return true;
  if (VIDEO_HOSTS.test(url.hostname)) return true;
  return /(^|\.)instagram\.com$/.test(url.hostname) && /^\/reels?\//.test(url.pathname);
}

/** Resolve a remote image reference to an absolute https URL that passes checkLink. */
function resolveImage(raw: string | undefined, pageUrl: URL): string | null {
  if (raw === undefined) return null;
  const trimmed = decodeEntities(raw.trim());
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  return checkLink(url.toString()).verdict === 'ok' ? url.toString() : null;
}

/** Build the preview from a fetched head. */
export function buildPreview(head: HeadData, base: PreviewBase, finalUrl: URL): CachedPreview {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = head.meta.get(key);
      if (value !== undefined && value.trim() !== '') return value;
    }
    return undefined;
  };
  const rawTitle = pick('og:title', 'twitter:title') ?? head.title ?? undefined;
  const title = rawTitle !== undefined ? cleanText(rawTitle, TITLE_CAP) : '';
  const rawDescription = pick('og:description', 'twitter:description', 'description');
  const description =
    rawDescription !== undefined ? cleanText(rawDescription, DESCRIPTION_CAP) || null : null;
  const rawSite = pick('og:site_name', 'application-name');
  const siteName = rawSite !== undefined ? cleanText(rawSite, 80) || null : null;
  const imageUrl = resolveImage(
    pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    finalUrl,
  );
  if (title === '') {
    return { preview: { type: 'bare', ...base }, imageUrl: null };
  }
  const video = isVideoPage(finalUrl, pick('og:type'));
  const durationSeconds = video
    ? parseDuration(pick('og:video:duration', 'video:duration', 'duration'))
    : null;
  return {
    preview: {
      type: imageUrl !== null ? 'full' : 'text',
      ...base,
      title,
      description,
      siteName,
      video,
      durationSeconds,
    },
    imageUrl,
  };
}

// ---------------------------------------------------------------------------
// Guarded fetch

export type Fetcher = (input: string, init: RequestInit, traceId: string) => Promise<Response>;

type HopOutcome =
  | { kind: 'ok'; response: Response; finalUrl: URL; hops: number }
  | { kind: 'unsafe'; finalUrl: URL; reasons: Reason[] }
  | { kind: 'login'; finalUrl: URL }
  | { kind: 'fail'; reason: string };

/** Throw away a body we will not read, without waiting on it. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/**
 * Fetch with manual redirects (max MAX_REDIRECTS), re-checking every hop. The
 * caller owns `signal` (the shared time budget). Sends no cookies, no
 * Authorization and none of the inbound request's headers.
 */
export async function guardedFetch(
  start: URL,
  accept: string,
  fetcher: Fetcher,
  traceId: string,
  signal: AbortSignal,
): Promise<HopOutcome> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = checkLink(current.toString());
    if (verdict.verdict === 'unsafe') {
      return { kind: 'unsafe', finalUrl: current, reasons: verdict.reasons };
    }
    if (hop > 0 && isLoginUrl(current)) return { kind: 'login', finalUrl: current };

    const response = await fetcher(
      current.toString(),
      {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en' },
      },
      traceId,
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      discard(response);
      if (location === null) return { kind: 'fail', reason: 'redirect_without_location' };
      try {
        current = new URL(location, current);
      } catch {
        return { kind: 'fail', reason: 'bad_location' };
      }
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      discard(response);
      return { kind: 'login', finalUrl: current };
    }
    if (!response.ok) {
      discard(response);
      return { kind: 'fail', reason: `status_${response.status}` };
    }
    return { kind: 'ok', response, finalUrl: current, hops: hop };
  }
  return { kind: 'fail', reason: 'too_many_redirects' };
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function charsetOf(response: Response): string {
  const match = (response.headers.get('content-type') ?? '').match(/charset=["']?([\w-]+)/i);
  return match?.[1]?.toLowerCase() ?? 'utf-8';
}

/** Read the body until </head> or MAX_HEAD_BYTES, then stop the stream. */
export async function readHead(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(response));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const reader = body.getReader();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_HEAD_BYTES - bytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += chunk.byteLength;
      const decoded = decoder.decode(chunk, { stream: true });
      text += decoded;
      // Only the new tail can complete </head>; avoids rescanning the whole text.
      if (bytes >= MAX_HEAD_BYTES || /<\/head\s*>/i.test(text.slice(-(decoded.length + 16)))) {
        break;
      }
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Read an image body up to `max` bytes; null when it is larger. */
async function readCapped(response: Response, max: number): Promise<ArrayBuffer | null> {
  const body = response.body;
  if (body === null) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

// ---------------------------------------------------------------------------
// Cache

/** The cache surface the handlers need; caches.default fits it. */
export interface PreviewCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Per-isolate memory layer in front of the Cache API (bounded, TTL-aware). */
export class MemoryLayer implements PreviewCache {
  private readonly entries = new Map<
    string,
    { body: ArrayBuffer; headers: [string, string][]; status: number; expires: number }
  >();
  private bytes = 0;

  /**
   * @param maxBytes total body bytes kept in isolate memory (Workers isolates
   *   have 128 MB); the oldest entries go first. Larger single bodies are not
   *   kept here at all, only passed to the edge cache.
   */
  constructor(
    private readonly inner: PreviewCache | null,
    private readonly maxBytes = MEMORY_LAYER_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  async match(key: string): Promise<Response | undefined> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expires > this.now()) {
      return new Response(hit.body.slice(0), { status: hit.status, headers: hit.headers });
    }
    if (hit !== undefined) this.drop(key);
    return this.inner !== null ? this.inner.match(key) : undefined;
  }

  async put(key: string, response: Response): Promise<void> {
    const maxAge = Number(
      (response.headers.get('cache-control') ?? '').match(/max-age=(\d+)/)?.[1] ?? '0',
    );
    const copy = this.inner !== null ? response.clone() : null;
    const body = await response.arrayBuffer();
    this.drop(key);
    if (body.byteLength <= this.maxBytes / 4) {
      while (this.bytes + body.byteLength > this.maxBytes) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.drop(oldest);
      }
      this.entries.set(key, {
        body,
        headers: [...response.headers.entries()],
        status: response.status,
        expires: this.now() + maxAge * 1000,
      });
      this.bytes += body.byteLength;
    }
    if (this.inner !== null && copy !== null) await this.inner.put(key, copy);
  }

  /** Bytes held now (tests). */
  size(): number {
    return this.bytes;
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.body.byteLength;
    this.entries.delete(key);
  }
}

function previewKey(normalized: string): string {
  return `${CACHE_ORIGIN}/v1/preview?u=${encodeURIComponent(normalized)}`;
}

function imageKey(normalized: string): string {
  return `${CACHE_ORIGIN}/v1/image?u=${encodeURIComponent(normalized)}`;
}

async function readCached(cache: PreviewCache, normalized: string): Promise<CachedPreview | null> {
  const hit = await cache.match(previewKey(normalized));
  if (hit === undefined) return null;
  try {
    return (await hit.json()) as CachedPreview;
  } catch {
    return null;
  }
}

async function writeCached(
  cache: PreviewCache,
  normalized: string,
  record: CachedPreview,
  ttl: number,
): Promise<void> {
  await cache.put(
    previewKey(normalized),
    new Response(JSON.stringify(record), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    }),
  );
}

// ---------------------------------------------------------------------------
// Rate cap

/** Sliding-window counter per user, in isolate memory. */
export class RateCap {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = RATE_LIMIT,
    private readonly windowMs = RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one call; false when the user is over the cap. */
  take(userId: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    if (this.hits.size > 10_000) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Handlers

export interface LinkPreviewDeps {
  fetcher: Fetcher;
  cache: PreviewCache;
  rate: RateCap;
  /** Verify the Bearer token; the user id (JWT sub) or null. */
  verify: (request: Request) => Promise<string | null>;
}

/**
 * Build the preview for one safe, normalized link: fetch the page under the
 * shared 5 s budget and parse its head. Never throws; a failure is 'bare'.
 */
export async function fetchPreview(
  link: URL,
  fetcher: Fetcher,
  traceId: string,
): Promise<{ record: CachedPreview; ttl: number }> {
  const base = linkBase(link);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_BUDGET_MS);
  try {
    const outcome = await guardedFetch(
      link,
      'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      fetcher,
      traceId,
      controller.signal,
    );
    if (outcome.kind === 'unsafe') {
      return {
        record: {
          preview: {
            type: 'unsafe',
            domain: hostLabel(outcome.finalUrl.hostname),
            reasons: outcome.reasons,
          },
          imageUrl: null,
        },
        ttl: TTL_UNSAFE_S,
      };
    }
    if (outcome.kind === 'login') {
      return {
        record: { preview: { type: 'login', ...base }, imageUrl: null },
        ttl: TTL_FAILURE_S,
      };
    }
    if (outcome.kind === 'fail') {
      logger.info('link preview fetch failed', { reason: outcome.reason });
      return { record: { preview: { type: 'bare', ...base }, imageUrl: null }, ttl: TTL_FAILURE_S };
    }
    const finalHost = hostLabel(outcome.finalUrl.hostname);
    const shortened = isShortener(link.hostname) && finalHost !== base.domain;
    const withVia: PreviewBase = shortened
      ? { ...base, finalDomain: finalHost, viaShortener: base.domain }
      : base;
    const type = mediaType(outcome.response);
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      discard(outcome.response);
      return {
        record: { preview: { type: 'bare', ...withVia }, imageUrl: null },
        ttl: TTL_FAILURE_S,
      };
    }
    const html = await readHead(outcome.response);
    const record = buildPreview(parseHead(html), withVia, outcome.finalUrl);
    return { record, ttl: record.preview.type === 'bare' ? TTL_FAILURE_S : TTL_SUCCESS_S };
  } catch (error) {
    logger.info('link preview fetch aborted', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { record: { preview: { type: 'bare', ...base }, imageUrl: null }, ttl: TTL_FAILURE_S };
  } finally {
    clearTimeout(timer);
  }
}

function allowedOrigins(env: LinkPreviewEnv): readonly string[] {
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return list.length > 0 ? list : DEFAULT_ALLOWED_ORIGINS;
}

function resolveAllowedOrigin(request: Request, env: LinkPreviewEnv): string | null {
  const origin = request.headers.get('Origin');
  if (origin === null) return null;
  return allowedOrigins(env).includes(origin) || isPreviewOrigin(origin) ? origin : null;
}

function preflightResponse(request: Request, env: LinkPreviewEnv): Response {
  const acao =
    resolveAllowedOrigin(request, env) ?? allowedOrigins(env)[0] ?? DEFAULT_ALLOWED_ORIGINS[0];
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': acao,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': `authorization, ${TRACE_ID_HEADER.toLowerCase()}`,
      'Access-Control-Max-Age': String(CORS_MAX_AGE_SECONDS),
      Vary: 'Origin',
    },
  });
}

function json(status: number, body: unknown, traceId: string, acao: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  headers.set(TRACE_ID_HEADER, traceId);
  if (acao !== null) {
    headers.set('Access-Control-Allow-Origin', acao);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function plain(status: number, traceId: string): Response {
  return new Response(null, { status, headers: { [TRACE_ID_HEADER]: traceId } });
}

async function handlePreview(
  request: Request,
  env: LinkPreviewEnv,
  deps: LinkPreviewDeps,
  traceId: string,
): Promise<Response> {
  const acao = resolveAllowedOrigin(request, env);
  const userId = await deps.verify(request);
  if (userId === null) {
    return json(401, { error: { code: 'unauthorized', message: 'Sign in again.' } }, traceId, acao);
  }
  const raw = new URL(request.url).searchParams.get('url') ?? '';
  if (raw === '' || raw.length > MAX_URL_LENGTH) {
    return json(400, { error: { code: 'bad_request', message: 'Missing url.' } }, traceId, acao);
  }
  if (!deps.rate.take(userId)) {
    return json(
      429,
      { error: { code: 'rate_limited', message: 'Too many previews.' } },
      traceId,
      acao,
    );
  }

  // The safety check runs before anything else: an unsafe link is never fetched.
  const verdict = checkLink(raw);
  if (verdict.verdict === 'unsafe') {
    let domain = '';
    try {
      domain = hostLabel(new URL(raw).hostname);
    } catch {
      domain = '';
    }
    const preview: LinkPreview = { type: 'unsafe', domain, reasons: verdict.reasons };
    return json(200, preview, traceId, acao);
  }
  const normalized = normalizeUrl(raw);
  if (normalized === null) {
    return json(400, { error: { code: 'bad_request', message: 'Not a web link.' } }, traceId, acao);
  }

  const cached = await readCached(deps.cache, normalized);
  if (cached !== null) return json(200, cached.preview, traceId, acao);

  const { record, ttl } = await fetchPreview(new URL(normalized), deps.fetcher, traceId);
  await writeCached(deps.cache, normalized, record, ttl);
  return json(200, record.preview, traceId, acao);
}

/** Security headers on every /image answer. */
function imageHeaders(contentType: string, traceId: string): Headers {
  return new Headers({
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': `public, max-age=${TTL_IMAGE_S}`,
    'cross-origin-resource-policy': 'cross-origin',
    [TRACE_ID_HEADER]: traceId,
  });
}

async function handleImage(
  request: Request,
  deps: LinkPreviewDeps,
  traceId: string,
): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('url') ?? '';
  if (raw === '' || raw.length > MAX_URL_LENGTH) return plain(400, traceId);
  const normalized = normalizeUrl(raw);
  if (normalized === null) return plain(400, traceId);

  // Only the image a cached preview recorded: never an arbitrary URL.
  const record = await readCached(deps.cache, normalized);
  if (record === null || record.imageUrl === null) return plain(404, traceId);

  const stored = await deps.cache.match(imageKey(normalized));
  if (stored !== undefined) return stored;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_BUDGET_MS);
  try {
    const outcome = await guardedFetch(
      new URL(record.imageUrl),
      'image/webp,image/png,image/jpeg,image/gif;q=0.9',
      deps.fetcher,
      traceId,
      controller.signal,
    );
    if (outcome.kind !== 'ok') return plain(404, traceId);
    const type = mediaType(outcome.response);
    if (!IMAGE_TYPES.has(type)) {
      discard(outcome.response);
      return plain(415, traceId);
    }
    const declared = Number(outcome.response.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) {
      discard(outcome.response);
      return plain(413, traceId);
    }
    const bytes = await readCapped(outcome.response, MAX_IMAGE_BYTES);
    if (bytes === null) return plain(413, traceId);
    const response = new Response(bytes, { status: 200, headers: imageHeaders(type, traceId) });
    await deps.cache.put(imageKey(normalized), response.clone());
    return response;
  } catch {
    return plain(404, traceId);
  } finally {
    clearTimeout(timer);
  }
}

/** The request router, with every collaborator injected (tests use fakes). */
export async function handleRequest(
  request: Request,
  env: LinkPreviewEnv,
  deps: LinkPreviewDeps,
): Promise<Response> {
  const traceId = extractTraceId(request);
  logger.setTraceId(traceId);
  try {
    if (request.method === 'OPTIONS') return preflightResponse(request, env);
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET') {
      return json(
        405,
        { error: { code: 'method_not_allowed', message: 'Use GET.' } },
        traceId,
        null,
      );
    }
    if (pathname === '/preview') return await handlePreview(request, env, deps, traceId);
    if (pathname === '/image') return await handleImage(request, deps, traceId);
    return plain(404, traceId);
  } catch (error) {
    logger.error(`link preview failed: ${error instanceof Error ? error.message : String(error)}`);
    return json(
      500,
      { error: { code: 'internal_error', message: 'Preview failed.' } },
      traceId,
      null,
    );
  } finally {
    logger.clearTraceId();
  }
}

// One per isolate: the memory cache layer and the rate counter live here.
let isolateDeps: LinkPreviewDeps | undefined;

function liveDeps(env: LinkPreviewEnv): LinkPreviewDeps {
  if (isolateDeps === undefined) {
    // The Workers runtime adds caches.default; the DOM lib typing lacks it.
    const edgeCache = (): Cache => (caches as unknown as { default: Cache }).default;
    const edge: PreviewCache = {
      match: (key) => edgeCache().match(key),
      put: (key, response) => edgeCache().put(key, response),
    };
    isolateDeps = {
      fetcher: (input, init, traceId) => tracedFetch(input, init, traceId),
      cache: new MemoryLayer(edge),
      rate: new RateCap(),
      verify: async (request) => {
        const caller = await verifyCaller(request, getSupabaseJwks(env));
        return caller.ok ? caller.value : null;
      },
    };
  }
  return isolateDeps;
}

export default {
  async fetch(request: Request, env: LinkPreviewEnv): Promise<Response> {
    return handleRequest(request, env, liveDeps(env));
  },
};
