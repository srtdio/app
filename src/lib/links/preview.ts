// Client for the link-preview Worker (src/server/workers/link-preview.ts).
//
// requestLinkPreview(url, signal) answers a LinkPreview and never throws for an
// expected failure: an unreachable Worker, a non-200 or a malformed body all
// become the 'bare' card (domain + path), so a card is never blank and never a
// spinner that stays. Unsafe links are decided here with the shared checkLink
// and are never sent to the Worker or fetched. Links to this app itself (its
// post/brief pages or any other same-origin page) never get a preview.
//
// One request per unique (normalized) URL per session: results live in memory,
// concurrent callers share the in-flight request, and at most 4 requests run at
// once. The cards only ask once they are within 300 px of the viewport
// (LinkPreviewCard + useInView). Missing VITE_LINK_PREVIEW_URL: every card is
// 'bare', nothing is requested.

import type { LinkPreview } from '@/server/workers/link-preview';
import { REASONS, checkLink, linkBase, normalizeUrl, type Reason } from '@/lib/links/safety';
import { fetchWithTrace } from '@/lib/fetch';
import { supabase } from '@/lib/supabase';

export type { LinkPreview };

/** Requests in flight at once, across every card on the page. */
export const MAX_CONCURRENT = 4;
/** How far outside the viewport a card starts asking (rootMargin). */
export const PREVIEW_ROOT_MARGIN = '300px';

const TITLE_CAP = 200;
const DESCRIPTION_CAP = 400;

/** The Worker base URL from the env, or null when unset/invalid. */
export function previewEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// Read directly (like src/components/home/media.ts): env.ts does not list it.
const rawEndpoint: unknown = import.meta.env.VITE_LINK_PREVIEW_URL;
const ENDPOINT = previewEndpoint(rawEndpoint);

/** The compact 'bare' card for a link, built without any request. */
export function barePreview(url: string): LinkPreview {
  try {
    return { type: 'bare', ...linkBase(new URL(url)) };
  } catch {
    return {
      type: 'bare',
      domain: url,
      path: '',
      letter: '?',
      finalDomain: null,
      viaShortener: null,
    };
  }
}

/** The warning card when the shared check flags the link, else null. */
export function localUnsafe(url: string): LinkPreview | null {
  const verdict = checkLink(url);
  if (verdict.verdict === 'ok') return null;
  let domain = url;
  try {
    domain = linkBase(new URL(url)).domain;
  } catch {
    // Keep the raw text as the label.
  }
  return { type: 'unsafe', domain, reasons: verdict.reasons };
}

/** True for a link to this app itself: such links keep their in-app behaviour. */
export function isAppLink(url: string, appOrigin: string | null): boolean {
  if (appOrigin === null) return false;
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

function str(value: unknown, cap: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  const points = Array.from(text);
  return points.length > cap ? points.slice(0, cap).join('') : text;
}

/**
 * Validate the Worker's JSON into a LinkPreview. Anything unexpected becomes
 * the bare card for `url`; strings are re-capped here too.
 */
export function parsePreview(body: unknown, url: string): LinkPreview {
  const bare = barePreview(url);
  if (typeof body !== 'object' || body === null) return bare;
  const b = body as Record<string, unknown>;
  if (b.type === 'unsafe') {
    // Only reason strings from the shared list are shown; never remote text.
    const known: readonly string[] = Object.values(REASONS);
    const reasons = Array.isArray(b.reasons)
      ? b.reasons.filter((r): r is Reason => typeof r === 'string' && known.includes(r))
      : [];
    return {
      type: 'unsafe',
      domain: str(b.domain, 253) ?? (bare.type === 'bare' ? bare.domain : url),
      reasons,
    };
  }
  if (bare.type !== 'bare') return bare;
  const base = {
    domain: bare.domain,
    path: bare.path,
    letter: str(b.letter, 1) ?? bare.letter,
    finalDomain: str(b.finalDomain, 253),
    viaShortener: str(b.viaShortener, 253),
  };
  if (b.type === 'login' || b.type === 'bare') return { type: b.type, ...base };
  if (b.type === 'full' || b.type === 'text') {
    const title = str(b.title, TITLE_CAP);
    if (title === null) return { type: 'bare', ...base };
    const duration = typeof b.durationSeconds === 'number' ? Math.round(b.durationSeconds) : null;
    return {
      type: b.type,
      ...base,
      title,
      description: str(b.description, DESCRIPTION_CAP),
      siteName: str(b.siteName, 80),
      video: b.video === true,
      durationSeconds: duration !== null && duration > 0 ? duration : null,
    };
  }
  return { type: 'bare', ...base };
}

export interface PreviewClientDeps {
  endpoint: string | null;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
  getToken: () => Promise<string | null>;
  maxConcurrent?: number;
  /** This app's origin: links to it are never previewed. */
  appOrigin?: string | null;
}

interface Pending {
  promise: Promise<LinkPreview>;
  controller: AbortController;
  waiters: number;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** A preview client with its own session cache. The app uses one shared instance. */
export function createPreviewClient(deps: PreviewClientDeps) {
  const done = new Map<string, LinkPreview>();
  const pending = new Map<string, Pending>();
  const limit = deps.maxConcurrent ?? MAX_CONCURRENT;
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    const next = queue.shift();
    if (next !== undefined) next();
    else active -= 1;
  }

  /** The preview when it is known without a request (unsafe, no endpoint, cached). */
  function peek(url: string): LinkPreview | null {
    const unsafe = localUnsafe(url);
    if (unsafe !== null) return unsafe;
    if (deps.endpoint === null || isAppLink(url, deps.appOrigin ?? null)) return barePreview(url);
    const key = normalizeUrl(url);
    return key !== null ? (done.get(key) ?? null) : barePreview(url);
  }

  async function run(key: string, url: string, controller: AbortController): Promise<LinkPreview> {
    await acquire();
    try {
      if (controller.signal.aborted) throw abortError();
      const token = await deps.getToken();
      if (token === null || deps.endpoint === null) return barePreview(url);
      const response = await deps.fetcher(
        `${deps.endpoint}/preview?url=${encodeURIComponent(key)}`,
        { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      if (!response.ok) return barePreview(url);
      const preview = parsePreview(await response.json(), url);
      done.set(key, preview);
      return preview;
    } catch {
      if (controller.signal.aborted) throw abortError();
      return barePreview(url);
    } finally {
      release();
      if (pending.get(key)?.controller === controller) pending.delete(key);
    }
  }

  /**
   * The preview for `url`. Rejects with AbortError only when `signal` aborts;
   * the shared request itself is cancelled once every waiter has gone.
   */
  function request(url: string, signal?: AbortSignal): Promise<LinkPreview> {
    const known = peek(url);
    if (known !== null) return Promise.resolve(known);
    const key = normalizeUrl(url);
    if (key === null) return Promise.resolve(barePreview(url));
    if (signal?.aborted === true) return Promise.reject(abortError());

    let entry = pending.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      entry = { promise: Promise.resolve(barePreview(url)), controller, waiters: 0 };
      entry.promise = run(key, url, controller);
      // Keep an unobserved rejection (every waiter aborted) quiet.
      entry.promise.catch(() => undefined);
      pending.set(key, entry);
    }
    const shared = entry;
    shared.waiters += 1;
    if (signal === undefined) return shared.promise;

    return new Promise<LinkPreview>((resolve, reject) => {
      const onAbort = (): void => {
        shared.waiters -= 1;
        if (shared.waiters === 0) {
          shared.controller.abort();
          if (pending.get(key) === shared) pending.delete(key);
        }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** The /image URL for a page's cached og:image, or null without an endpoint. */
  function imageUrl(url: string): string | null {
    const key = normalizeUrl(url);
    return deps.endpoint !== null && key !== null
      ? `${deps.endpoint}/image?url=${encodeURIComponent(key)}`
      : null;
  }

  return { request, peek, imageUrl };
}

export type PreviewClient = ReturnType<typeof createPreviewClient>;

let shared: PreviewClient | null = null;

/** The app-wide client: fetchWithTrace + the signed-in user's access token. */
export function previewClient(): PreviewClient {
  if (shared === null) {
    shared = createPreviewClient({
      endpoint: ENDPOINT,
      fetcher: (input, init) => fetchWithTrace(input, init),
      appOrigin: typeof window !== 'undefined' ? window.location.origin : null,
      getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    });
  }
  return shared;
}

/** requestLinkPreview(url, signal) on the app-wide client. */
export function requestLinkPreview(url: string, signal?: AbortSignal): Promise<LinkPreview> {
  return previewClient().request(url, signal);
}
