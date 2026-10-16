// Ad tracking tags (Meta Pixel, Google tag / Google Ads, LinkedIn Insight) for
// the public home bundle only. Each tag loads after first paint and only when
// its VITE_* id is set at build time; with no ids nothing is injected. Home
// pages navigate with full page loads, so the base tags record every page view.

type QueueFn = (...args: unknown[]) => void;

interface Fbq extends QueueFn {
  callMethod?: QueueFn;
  queue: unknown[];
  push: Fbq;
  loaded: boolean;
  version: string;
}

interface Lintrk extends QueueFn {
  q: unknown[];
}

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
    dataLayer?: unknown[];
    gtag?: QueueFn;
    lintrk?: Lintrk;
    _linkedin_partner_id?: string;
    _linkedin_data_partner_ids?: string[];
  }
}

const META_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';
const LINKEDIN_SRC = 'https://snap.licdn.com/li.lms-analytics/insight.min.js';

const DIGITS = /^\d+$/;
const GOOGLE_TAG = /^G-[A-Z0-9]+$/i;
const GOOGLE_ADS = /^AW-[A-Z0-9-]+$/i;

let scheduled = false;

// Lazy so the logger (and the Sentry SDK it imports) stays out of first paint.
let loggerModule: Promise<typeof import('@/lib/logger')> | null = null;

function warn(message: string, context: Record<string, unknown>): void {
  loggerModule ??= import('@/lib/logger');
  void loggerModule.then(({ logger }) => logger.warn(message, context)).catch(() => undefined);
}

/** The id for `name` when set and valid; undefined (with a warning if invalid) otherwise. */
function readId(name: string, raw: unknown, pattern: RegExp): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const id = raw.trim();
  if (pattern.test(id)) return id;
  warn('ad tag id invalid, skipped', { var: name });
  return undefined;
}

function injectScript(src: string): void {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const script = document.createElement('script');
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

function loadMeta(id: string): void {
  if (!window.fbq) {
    const fbq = function (...args: unknown[]): void {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    window.fbq = fbq;
    window._fbq ??= fbq;
  }
  injectScript(META_SRC);
  window.fbq('init', id);
  window.fbq('track', 'PageView');
}

function loadGoogle(ids: string[]): void {
  const first = ids[0];
  if (first === undefined) return;
  window.dataLayer ??= [];
  // gtag.js only reads Arguments objects from the dataLayer, not arrays.
  window.gtag ??= function gtag(): void {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer?.push(arguments);
  };
  injectScript(`${GTAG_SRC}?id=${encodeURIComponent(first)}`);
  window.gtag('js', new Date());
  for (const id of ids) window.gtag('config', id);
}

function loadLinkedIn(id: string): void {
  window._linkedin_partner_id = id;
  const ids = (window._linkedin_data_partner_ids ??= []);
  if (!ids.includes(id)) ids.push(id);
  if (!window.lintrk) {
    const lintrk = function (...args: unknown[]): void {
      lintrk.q.push(args);
    } as Lintrk;
    lintrk.q = [];
    window.lintrk = lintrk;
  }
  injectScript(LINKEDIN_SRC);
}

function injectAdTags(): void {
  try {
    const env = import.meta.env;
    const meta = readId('VITE_META_PIXEL_ID', env.VITE_META_PIXEL_ID, DIGITS);
    const googleTag = readId('VITE_GOOGLE_TAG_ID', env.VITE_GOOGLE_TAG_ID, GOOGLE_TAG);
    const googleAds = readId('VITE_GOOGLE_ADS_ID', env.VITE_GOOGLE_ADS_ID, GOOGLE_ADS);
    const linkedIn = readId('VITE_LINKEDIN_PARTNER_ID', env.VITE_LINKEDIN_PARTNER_ID, DIGITS);
    if (meta) loadMeta(meta);
    loadGoogle([googleTag, googleAds].filter((id): id is string => id !== undefined));
    if (linkedIn) loadLinkedIn(linkedIn);
  } catch (err) {
    warn('ad tags failed to load', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Loads the configured ad tags once, when the browser is idle (setTimeout where unsupported). */
export function loadAdTags(): void {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(injectAdTags, { timeout: 4000 });
  } else {
    window.setTimeout(injectAdTags, 1500);
  }
}
