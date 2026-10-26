// Links in a chat message body. Pure string logic, no I/O: tokenize splits a body
// into text and url runs (the same URL regex and trailing-punctuation trim the
// post Comments body uses, copied here rather than imported), and classify tells
// an external url from a pasted link to one of this app's own post or brief
// pages. The bubble renders the runs; the composer resolves internal refs to
// shared cards at Send.

import { matchPath } from 'react-router-dom';
import { parseEntityRef, type EntityRef } from '@/lib/entityRef';

const URL_TOKEN = /https?:\/\/[^\s<]+/gi;
const URL_TRAILING = /[.,;:!?)\]}'"]+$/;

/** One run of a message body: plain text, or an http(s) url. */
type BodySegment = { kind: 'text'; text: string } | { kind: 'url'; url: string };

/**
 * Split a body into text and url runs in order. Trailing sentence punctuation
 * after a url stays in the following text run. Only http and https match; a bare
 * domain with no scheme stays text. Adjacent text runs are merged.
 */
export function tokenize(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const pushText = (text: string): void => {
    if (text === '') return;
    const prev = segments[segments.length - 1];
    if (prev?.kind === 'text') prev.text += text;
    else segments.push({ kind: 'text', text });
  };
  let last = 0;
  for (const m of body.matchAll(URL_TOKEN)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = url.match(URL_TRAILING);
    const suffix = trail !== null ? trail[0] : '';
    if (suffix !== '') url = url.slice(0, url.length - suffix.length);
    pushText(body.slice(last, start));
    // Trimming can leave a bare scheme ("http://."): that stays text.
    if (/^https?:\/\/./i.test(url)) {
      segments.push({ kind: 'url', url });
    } else {
      pushText(url);
    }
    pushText(suffix);
    last = start + m[0].length;
  }
  pushText(body.slice(last));
  return segments;
}

/** The app's pretty entity route patterns (see the /p/:ref and /b/:ref routes in src/App.tsx). */
export interface EntityRoutes {
  post: string;
  brief: string;
}

/** The route patterns App.tsx mounts PostRefResolver and BriefRefResolver on. */
export const APP_ENTITY_ROUTES: EntityRoutes = { post: '/p/:ref', brief: '/b/:ref' };

/** What a url in a message points at. `path` is the in-app location for the router. */
type LinkTarget = { kind: 'external' } | { kind: 'post' | 'brief'; ref: EntityRef; path: string };

/**
 * Classify a url: a link to this app's own post or brief page (same origin, a
 * matching route, a parseable ref) is internal; anything else, including the
 * same path on a foreign origin, is external.
 */
export function classify(url: string, appOrigin: string | null, routes: EntityRoutes): LinkTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'external' };
  }
  if (appOrigin === null || parsed.origin !== appOrigin) return { kind: 'external' };
  for (const kind of ['post', 'brief'] as const) {
    const match = matchPath({ path: routes[kind], end: true }, parsed.pathname);
    const raw = match?.params.ref;
    const ref = raw !== undefined ? parseEntityRef(raw) : null;
    if (ref !== null)
      return { kind, ref, path: `${parsed.pathname}${parsed.search}${parsed.hash}` };
  }
  return { kind: 'external' };
}

/** window.location.origin at call time; null outside a browser. */
export function currentOrigin(): string | null {
  return typeof window !== 'undefined' && typeof window.location !== 'undefined'
    ? window.location.origin
    : null;
}

/** A url as shown in a bubble: the scheme dropped. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

/**
 * The one link in a body that gets a preview card (WhatsApp rule): the first
 * external url. Links to this app's own pages (post/brief refs and any other
 * same-origin url) are skipped; they keep their in-app behaviour. Pure.
 */
export function firstExternalUrl(
  body: string,
  appOrigin: string | null = currentOrigin(),
  routes: EntityRoutes = APP_ENTITY_ROUTES,
): string | null {
  for (const segment of tokenize(body)) {
    if (segment.kind !== 'url') continue;
    if (classify(segment.url, appOrigin, routes).kind !== 'external') continue;
    let sameOrigin = false;
    try {
      sameOrigin = appOrigin !== null && new URL(segment.url).origin === appOrigin;
    } catch {
      continue;
    }
    if (!sameOrigin) return segment.url;
  }
  return null;
}
