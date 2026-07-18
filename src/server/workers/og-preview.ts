// Cloudflare Worker: og-preview.
//
// Makes WhatsApp/social link previews work for post links. The srtd.io SPA
// serves index.html for every path and carries zero Open Graph tags, so a link
// like https://srtd.io/posts/:postId unfurls as a blank card in messaging apps.
// This Worker sits on the zone routes srtd.io/posts/* and srtd.io/og/* in front
// of Pages (Workers routes take precedence over the Pages custom domain) and:
//
//   * GET/HEAD /posts/:postId
//       - a real browser (or any non-matching path) is passed through to Pages
//         untouched; auth is localStorage-based so no cookie handling is needed.
//       - a known crawler (WhatsApp, facebookexternalhit, ...) gets a minimal
//         HTML document with og:title + first image only. noindex so search
//         engines never index post pages while messaging apps still preview.
//   * GET/HEAD /og/p/:postId/:assetVersionId.jpg
//       - the first image's bytes, resized through Cloudflare image transforms.
//         The version id in the URL is the cache-buster, so the response is
//         immutable and cached for a year.
//
// The Worker is the only holder of the Supabase service-role key and the R2
// credentials; neither is ever shipped to the browser. This surface is
// deliberately public and unauthenticated for crawler access (approved product
// decision, title + first image only): no JWKS, no CORS, top-level document and
// image fetches only.
//
// Read-only, matching asset-read's read-path doctrine: no idempotency key, no
// audit row, no mutation. Expected failures are typed Results mapped to 4xx;
// system faults throw and become a 500.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { R2StorageClient } from '@srtdio/storage';
import { tracedFetch } from '@/server/traced-fetch';
import { extractTraceId } from '@/server/trace';
import { logger } from '@/server/logger';
import { parseEntityRef, type EntityRef } from '@/lib/entityRef';

export interface OgPreviewEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  /** Service role: used only for the server-side row lookups below. */
  SUPABASE_SECRET_KEY: string;
  /** Origin of the Cloudflare Pages deployment we pass human traffic through to. */
  PAGES_ORIGIN: string;
}

/** Production site origin; the absolute base for og:url and og:image. */
const SITE_ORIGIN = 'https://srtd.io';

/** Signed-URL lifetime for the internal R2 read: minted and fetched at once. */
const PRESIGN_TTL_SECONDS = 300;

/** Post-card cache lifetime: 5 minutes. */
const CARD_MAX_AGE_SECONDS = 300;

/** Negative/404 cache lifetime for the image endpoint: 1 minute. */
const IMAGE_MISS_MAX_AGE_SECONDS = 60;

/** Immutable image cache lifetime: 1 year (the version id is the cache-buster). */
const IMAGE_HIT_MAX_AGE_SECONDS = 31_536_000;

/**
 * User-Agent substrings that identify a link-preview crawler. Matched
 * case-insensitively against the full UA string. Deliberately narrow: the bare
 * token "bot" is NOT here, so only these named crawlers see the OG card.
 */
const CRAWLER_TOKENS: readonly string[] = [
  'whatsapp',
  'facebookexternalhit',
  'facebookcatalog',
  'twitterbot',
  'linkedinbot',
  'slackbot',
  'telegrambot',
  'discordbot',
  'pinterest',
  'skypeuripreview',
];

/** True iff the User-Agent names one of the known preview crawlers. */
export function isCrawler(userAgent: string | null): boolean {
  if (userAgent === null || userAgent === '') {
    return false;
  }
  const ua = userAgent.toLowerCase();
  return CRAWLER_TOKENS.some((token) => ua.includes(token));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff the string is a canonical (hyphenated) UUID. */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape every character that is special inside HTML text or an attribute. */
function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** The first image attached to a post, with any real dimensions the row carries. */
export interface PostImage {
  assetVersionId: string;
  /** Pixel width, only when the version row exposes it; never guessed. */
  width: number | null;
  /** Pixel height, only when the version row exposes it; never guessed. */
  height: number | null;
}

/** Where a bound image version's bytes live: its bucket and object key. */
export interface ImageLocator {
  bucket: string | null;
  r2Key: string | null;
}

/**
 * The service-role reads the Worker needs. Kept as an interface so tests inject
 * a fake and exercise the rendering and 404 branching without a network.
 */
export interface OgPreviewStore {
  /** Post title iff a live (deleted_at IS NULL) post exists, else null. */
  findPostTitle(postId: string): Promise<string | null>;
  /**
   * Resolve a pretty ref (workspace key + entity number) to a live post's id and
   * title. Two lookups only: workspaces.id by the uppercase key, then posts by
   * (workspace_id, number) with deleted_at null. Null on unknown key or a
   * missing/deleted post.
   */
  findPostByRef(ref: EntityRef): Promise<{ postId: string; title: string } | null>;
  /**
   * Resolve a pretty ref (workspace key + entity number) to a live brief's id and
   * title. Two lookups only: workspaces.id by the uppercase key, then briefs by
   * (workspace_id, number) with deleted_at null. Null on unknown key or a
   * missing/deleted brief.
   */
  findBriefByRef(ref: EntityRef): Promise<{ briefId: string; title: string } | null>;
  /** First image attachment of a live post, ordered position, attached_at, id. */
  findFirstPostImage(postId: string): Promise<PostImage | null>;
  /**
   * Locate the bytes for the (post, version) pair iff a live attachment binds
   * them, the post is live, and the version is an image. Null on any miss.
   */
  findBoundImage(input: { postId: string; assetVersionId: string }): Promise<ImageLocator | null>;
}

/** Mints a presigned GET URL for an object. Implemented by R2StorageClient. */
export interface PresignedUrlSigner {
  presignGetUrl(input: { bucket: string; key: string; expiresInSeconds: number }): Promise<string>;
}

/**
 * A fetch that applies the Cloudflare image transformation. Injected so tests
 * exercise the response wrapping without a real image pipeline. Where the zone
 * lacks image transformations Cloudflare passes the original through, so no code
 * branch is needed.
 */
type FetchTransformedImage = (presignedUrl: string) => Promise<Response>;

/** The `cf` request extension carrying Cloudflare image-resize options. */
interface CfImageRequestInit extends RequestInit {
  cf: {
    image: {
      width: number;
      fit: 'scale-down';
      quality: number;
      format: 'jpeg';
    };
  };
}

/** The real transformed-image fetch: resize to 1200 wide, scale-down, JPEG. */
const fetchTransformedImage: FetchTransformedImage = (presignedUrl) => {
  const init: CfImageRequestInit = {
    cf: { image: { width: 1200, fit: 'scale-down', quality: 80, format: 'jpeg' } },
  };
  return globalThis.fetch(presignedUrl, init);
};

/** The Open Graph card model: what to render, already resolved from the store. */
interface CardModel {
  /** og:title text. */
  title: string;
  /** og:url; null for the generic (unknown-post) card. */
  url: string | null;
  /** og:image; null when the post has no image. */
  image: { url: string; width: number | null; height: number | null } | null;
}

function ogMeta(property: string, content: string): string {
  return `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
}

function nameMeta(name: string, content: string): string {
  return `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
}

/**
 * Build the minimal HTML document a crawler receives: og tags and nothing else.
 * No caption, no description. Every interpolated value is HTML-escaped. Always
 * carries a noindex robots meta so search engines never index post pages.
 */
function renderCard(model: CardModel): string {
  const tags: string[] = [ogMeta('og:title', model.title), ogMeta('og:site_name', 'Sorted')];
  if (model.url !== null) {
    tags.push(ogMeta('og:type', 'article'), ogMeta('og:url', model.url));
  }
  if (model.image !== null) {
    tags.push(ogMeta('og:image', model.image.url));
    if (model.image.width !== null) {
      tags.push(ogMeta('og:image:width', String(model.image.width)));
    }
    if (model.image.height !== null) {
      tags.push(ogMeta('og:image:height', String(model.image.height)));
    }
    tags.push(nameMeta('twitter:card', 'summary_large_image'));
  } else {
    tags.push(nameMeta('twitter:card', 'summary'));
  }
  tags.push(nameMeta('robots', 'noindex'));
  return `<!doctype html><html><head><meta charset="utf-8">${tags.join('')}</head><body></body></html>`;
}

function cardResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${CARD_MAX_AGE_SECONDS}`,
      'x-robots-tag': 'noindex',
    },
  });
}

/** The generic "Sorted" card: no post url, no image. Always HTTP 200. */
function genericCard(): Response {
  return cardResponse(renderCard({ title: 'Sorted', url: null, image: null }));
}

/**
 * Render the card for a known live post: its title, the given canonical og:url,
 * and its first image (if any). One lookup (the first image); the caller has
 * already resolved id and title.
 */
async function renderResolvedPostCard(
  postId: string,
  title: string,
  ogUrl: string,
  store: OgPreviewStore,
): Promise<Response> {
  const image = await store.findFirstPostImage(postId);
  return cardResponse(
    renderCard({
      title,
      url: ogUrl,
      image:
        image === null
          ? null
          : {
              url: `${SITE_ORIGIN}/og/p/${postId}/${image.assetVersionId}.jpg`,
              width: image.width,
              height: image.height,
            },
    }),
  );
}

/**
 * The crawler card for a post id: the generic "Sorted" card for an invalid uuid
 * or unknown post, otherwise the post's title plus its first image (if any).
 * Always HTTP 200 so the crawler always gets a usable card.
 */
export async function renderPostCard(postId: string, store: OgPreviewStore): Promise<Response> {
  if (!isUuid(postId)) {
    return genericCard();
  }
  const title = await store.findPostTitle(postId);
  if (title === null) {
    return genericCard();
  }
  return renderResolvedPostCard(postId, title, `${SITE_ORIGIN}/posts/${postId}`, store);
}

/**
 * The crawler card for a pretty short link /p/<key>-<number>. Resolves the ref
 * to a live post via two lookups, then renders the same card as /posts/:postId
 * but with og:url pointing at the short link. An unparseable ref, unknown key,
 * or missing/deleted post yields the generic card, matching a missing post on
 * /posts/*. Always HTTP 200.
 */
export async function renderShortLinkCard(ref: string, store: OgPreviewStore): Promise<Response> {
  const parsed = parseEntityRef(ref);
  if (parsed === null) {
    return genericCard();
  }
  const target = await store.findPostByRef(parsed);
  if (target === null) {
    return genericCard();
  }
  return renderResolvedPostCard(target.postId, target.title, `${SITE_ORIGIN}/p/${ref}`, store);
}

/**
 * The crawler card for a pretty brief short link /b/<key>-<number>. Resolves the
 * ref to a live brief via two lookups, then renders a title-only card: og:title
 * is the brief title, og:url points at the short link, twitter:card is summary.
 * Briefs carry no OG image by design, so this never queries attachments and there
 * is no /og/b/* endpoint. An unparseable ref, unknown key, or missing/deleted
 * brief yields the generic card. Always HTTP 200.
 */
export async function renderBriefLinkCard(ref: string, store: OgPreviewStore): Promise<Response> {
  const parsed = parseEntityRef(ref);
  if (parsed === null) {
    return genericCard();
  }
  const target = await store.findBriefByRef(parsed);
  if (target === null) {
    return genericCard();
  }
  return cardResponse(
    renderCard({ title: target.title, url: `${SITE_ORIGIN}/b/${ref}`, image: null }),
  );
}

function imageMiss(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': `public, max-age=${IMAGE_MISS_MAX_AGE_SECONDS}` },
  });
}

export interface ImageRouteDeps {
  store: OgPreviewStore;
  signer: PresignedUrlSigner;
  fetchImage: FetchTransformedImage;
}

/**
 * Serve the transformed bytes for the (post, version) pair. Validates both path
 * segments, binds the pair against a live post and image version, presigns an
 * internal R2 GET, then fetches it through the image transform. Any bind failure
 * is a cacheable 404; an upstream failure is a 502.
 */
export async function serveOgImage(
  postId: string,
  assetVersionId: string,
  deps: ImageRouteDeps,
): Promise<Response> {
  if (!isUuid(postId) || !isUuid(assetVersionId)) {
    return imageMiss();
  }
  const locator = await deps.store.findBoundImage({ postId, assetVersionId });
  if (locator === null || locator.bucket === null || locator.r2Key === null) {
    return imageMiss();
  }
  const url = await deps.signer.presignGetUrl({
    bucket: locator.bucket,
    key: locator.r2Key,
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  });
  const upstream = await deps.fetchImage(url);
  if (!upstream.ok) {
    return new Response(null, { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': `public, max-age=${IMAGE_HIT_MAX_AGE_SECONDS}, immutable`,
      'x-robots-tag': 'noindex',
    },
  });
}

/** Forward the request to Pages untouched, preserving method, path, and query. */
function passthrough(request: Request, env: OgPreviewEnv): Promise<Response> {
  const url = new URL(request.url);
  return globalThis.fetch(`${env.PAGES_ORIGIN}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
  });
}

/**
 * Service-role-backed store. The service role bypasses RLS; the Worker is the
 * only caller and never exposes this key. supabase-js is a stateless HTTP client
 * (no pooled connection to close); it is built per request and discarded when
 * this function returns.
 */
function createSupabaseOgPreviewStore(env: {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}): OgPreviewStore {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  return {
    async findPostTitle(postId) {
      const { data, error } = await client
        .from('posts')
        .select('title')
        .eq('id', postId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data?.title ?? null;
    },

    async findPostByRef({ key, number }) {
      // Two lookups, no join, no N+1: the active workspace by its key, then the
      // live post by (workspace_id, number). entity numbers are per-workspace.
      const { data: workspace, error: workspaceError } = await client
        .from('workspaces')
        .select('id')
        .eq('key', key)
        .is('deleted_at', null)
        .maybeSingle();
      if (workspaceError) {
        throw workspaceError;
      }
      if (!workspace) {
        return null;
      }
      const { data: post, error: postError } = await client
        .from('posts')
        .select('id, title')
        .eq('workspace_id', workspace.id)
        .eq('number', number)
        .is('deleted_at', null)
        .maybeSingle();
      if (postError) {
        throw postError;
      }
      if (!post) {
        return null;
      }
      return { postId: post.id, title: post.title };
    },

    async findBriefByRef({ key, number }) {
      // Two lookups, no join, no N+1: the active workspace by its key, then the
      // live brief by (workspace_id, number). entity numbers are per-workspace.
      const { data: workspace, error: workspaceError } = await client
        .from('workspaces')
        .select('id')
        .eq('key', key)
        .is('deleted_at', null)
        .maybeSingle();
      if (workspaceError) {
        throw workspaceError;
      }
      if (!workspace) {
        return null;
      }
      const { data: brief, error: briefError } = await client
        .from('briefs')
        .select('id, title')
        .eq('workspace_id', workspace.id)
        .eq('number', number)
        .is('deleted_at', null)
        .maybeSingle();
      if (briefError) {
        throw briefError;
      }
      if (!brief) {
        return null;
      }
      return { briefId: brief.id, title: brief.title };
    },

    async findFirstPostImage(postId) {
      // asset_versions carries no soft-delete column, so nothing to filter there;
      // width/height are the only real dimensions, emitted only when non-null.
      const { data, error } = await client
        .from('asset_attachments')
        .select('asset_version_id, asset_versions!inner(width, height)')
        .eq('entity_type', 'post')
        .eq('entity_id', postId)
        .is('deleted_at', null)
        .eq('asset_versions.kind', 'image')
        .order('position', { ascending: true })
        .order('attached_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      if (!data) {
        return null;
      }
      const version = data.asset_versions as { width: number | null; height: number | null } | null;
      return {
        assetVersionId: data.asset_version_id,
        width: version?.width ?? null,
        height: version?.height ?? null,
      };
    },

    async findBoundImage({ postId, assetVersionId }) {
      // The post must be live; entity_id is TEXT and compared as text.
      const { data: post, error: postError } = await client
        .from('posts')
        .select('id')
        .eq('id', postId)
        .is('deleted_at', null)
        .maybeSingle();
      if (postError) {
        throw postError;
      }
      if (!post) {
        return null;
      }
      const { data, error } = await client
        .from('asset_attachments')
        .select('asset_versions!inner(r2_key, workspaces!inner(asset_bucket))')
        .eq('entity_type', 'post')
        .eq('entity_id', postId)
        .eq('asset_version_id', assetVersionId)
        .is('deleted_at', null)
        .eq('asset_versions.kind', 'image')
        .maybeSingle();
      if (error) {
        throw error;
      }
      if (!data) {
        return null;
      }
      const version = data.asset_versions as {
        r2_key: string | null;
        workspaces: { asset_bucket: string | null } | null;
      } | null;
      return {
        bucket: version?.workspaces?.asset_bucket ?? null,
        r2Key: version?.r2_key ?? null,
      };
    },
  };
}

/**
 * Route the request. /posts/:postId, /p/<key>-<number>, and /b/<key>-<number>
 * serve the crawler card to known crawlers and pass everything else through;
 * /og/p/:postId/:assetVersionId.jpg serves transformed image bytes. Any other
 * /og/* path is a 404.
 */
async function route(request: Request, env: OgPreviewEnv): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const isRead = request.method === 'GET' || request.method === 'HEAD';

  if (segments[0] === 'posts') {
    // Only a bare /posts/:postId read from a known crawler gets the card; any
    // deeper path, non-read method, or human is transparently passed through.
    if (isRead && segments.length === 2 && isCrawler(request.headers.get('User-Agent'))) {
      return renderPostCard(segments[1] ?? '', createSupabaseOgPreviewStore(env));
    }
    return passthrough(request, env);
  }

  if (segments[0] === 'p') {
    // Only a bare /p/<ref> read from a known crawler gets the card; any deeper
    // path, non-read method, or human is transparently passed through.
    if (isRead && segments.length === 2 && isCrawler(request.headers.get('User-Agent'))) {
      return renderShortLinkCard(segments[1] ?? '', createSupabaseOgPreviewStore(env));
    }
    return passthrough(request, env);
  }

  if (segments[0] === 'b') {
    // Only a bare /b/<ref> read from a known crawler gets the card; any deeper
    // path, non-read method, or human is transparently passed through.
    if (isRead && segments.length === 2 && isCrawler(request.headers.get('User-Agent'))) {
      return renderBriefLinkCard(segments[1] ?? '', createSupabaseOgPreviewStore(env));
    }
    return passthrough(request, env);
  }

  if (segments[0] === 'og') {
    const last = segments[3] ?? '';
    if (isRead && segments.length === 4 && segments[1] === 'p' && last.endsWith('.jpg')) {
      return serveOgImage(segments[2] ?? '', last.slice(0, -'.jpg'.length), {
        store: createSupabaseOgPreviewStore(env),
        signer: new R2StorageClient(
          {
            CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
            CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
            CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
          },
          tracedFetch,
        ),
        fetchImage: fetchTransformedImage,
      });
    }
    return new Response(null, { status: 404 });
  }

  // Nothing else is routed to this Worker, but stay a safe passthrough.
  return passthrough(request, env);
}

/**
 * Temporary diagnostic: one line of env sanity that never prints a secret value.
 * SUPABASE_URL is reduced to its hostname (or MISSING/INVALID), the secret key to
 * its length and a 6-char prefix only.
 */
function envSanityLine(env: OgPreviewEnv): string {
  const rawUrl: string | undefined = env.SUPABASE_URL;
  let host: string;
  if (rawUrl === undefined || rawUrl === '') {
    host = 'MISSING';
  } else {
    try {
      host = new URL(rawUrl).hostname;
    } catch (err: unknown) {
      host = `INVALID:${String(err)}`;
    }
  }
  const key: string | undefined = env.SUPABASE_SECRET_KEY;
  const len = typeof key === 'string' ? key.length : 0;
  const prefix = typeof key === 'string' && key.length > 0 ? key.slice(0, 6) : 'MISSING';
  return `env SUPABASE_URL host=${host} SUPABASE_SECRET_KEY len=${len} prefix=${prefix}`;
}

/**
 * Temporary diagnostic: fully serialize a thrown value by shape so a non-Error
 * throw (a plain object, a supabase-js error) is legible instead of collapsing to
 * "[object Object]". Never throws itself.
 */
function serializeThrown(error: unknown): string {
  if (error instanceof Error) {
    const stackLines = (error.stack ?? '').split('\n').slice(0, 4).join('\n');
    let out = `${error.name}: ${error.message}`;
    if (stackLines !== '') {
      out += `\n${stackLines}`;
    }
    const extra: Record<string, unknown> = {};
    for (const prop of Object.keys(error)) {
      if (prop === 'message' || prop === 'stack') {
        continue;
      }
      extra[prop] = (error as unknown as Record<string, unknown>)[prop];
    }
    if (Object.keys(extra).length > 0) {
      try {
        out += `\n${JSON.stringify(extra)}`;
      } catch {
        // Non-serializable extras are dropped; the message and stack still stand.
      }
    }
    return out;
  }
  if (typeof error === 'object' && error !== null) {
    const ctor = (error as { constructor?: { name?: string } }).constructor?.name;
    const label = ctor !== undefined && ctor !== '' ? `${ctor} ` : '';
    try {
      return `${label}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
    } catch {
      return `${label}${String(error)}`;
    }
  }
  return String(error);
}

export default {
  async fetch(request: Request, env: OgPreviewEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    try {
      return await route(request, env);
    } catch (error) {
      const errName = error instanceof Error ? error.name : 'UnknownError';
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack =
        error instanceof Error && error.stack ? (error.stack.split('\n')[1]?.trim() ?? '') : '';
      logger.error(`og preview failed: ${errName}: ${errMsg} ${errStack}`.trim());
      // Temporary diagnostic: opt-in per request via x-og-debug: 1 to read the
      // runtime crash plus env sanity. Normal requests still get an opaque empty
      // 500. Capped at 2000 chars; never prints a secret value.
      if (request.headers.get('x-og-debug') === '1') {
        const body = `${envSanityLine(env)}\n${serializeThrown(error)}`.slice(0, 2000);
        return new Response(body, {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      return new Response(null, { status: 500 });
    } finally {
      logger.clearTraceId();
    }
  },
};
