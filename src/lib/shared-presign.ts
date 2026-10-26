// The one presign cache for the whole app: every screen that shows pictures
// (chat, Pipeline, Assets, Briefs, Activity, post and brief pages) shares it, so
// a picture signed on one screen is never signed again on the next, and small
// pictures' URLs are kept on the device across app restarts.

import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { localLinkKeyStore, localThumbnailUrlStore } from '@/lib/local-cache';
import { supabase } from '@/lib/supabase';

/** The origin that serves fast file links (the asset-read Worker's srtd.io/f/* route). */
const FILE_LINK_ORIGIN = 'https://srtd.io';

/**
 * Fast file links are on for the live site and its test / preview sites (they
 * share the same asset-read Worker and secret). Anywhere else (local dev, the
 * e2e harness) keeps the per-file presign path unless VITE_FILE_BASE_URL is set.
 * Pure given the host.
 */
export function defaultFileBase(hostname: string | null): string | null {
  if (hostname === null) return null;
  const ours =
    hostname === 'srtd.io' ||
    hostname === 'srtdio-app.pages.dev' ||
    hostname.endsWith('.srtdio-app.pages.dev');
  return ours ? FILE_LINK_ORIGIN : null;
}

export const appPresignDeps: PresignDeps = {
  endpoint: env.VITE_ASSET_READ_URL ?? null,
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  fetcher: (input, init) => fetchWithTrace(input, init),
  // Fast file links: pictures, videos and downloads load from srtd.io/f/* through
  // Cloudflare's edge cache, with one link-key request a day instead of one
  // presign per file. Off outside our own sites; VITE_FILE_BASE_URL
  // overrides the origin.
  fileBase:
    env.VITE_FILE_BASE_URL ??
    defaultFileBase(typeof window === 'undefined' ? null : window.location.hostname),
  linkKeyStore: localLinkKeyStore,
};

let appCache: PresignCache | null = null;

/** The app-wide presign cache, made on first use. */
export function appPresignCache(): PresignCache {
  if (appCache === null) {
    appCache = new PresignCache(appPresignDeps, undefined, undefined, localThumbnailUrlStore);
  }
  return appCache;
}
