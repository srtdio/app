// The one presign cache for the whole app: every screen that shows pictures
// (chat, Pipeline, Assets, Briefs, Activity, post and brief pages) shares it, so
// a picture signed on one screen is never signed again on the next, and small
// pictures' URLs are kept on the device across app restarts.

import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { localThumbnailUrlStore } from '@/lib/local-cache';
import { supabase } from '@/lib/supabase';

export const appPresignDeps: PresignDeps = {
  endpoint: env.VITE_ASSET_READ_URL ?? null,
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  fetcher: (input, init) => fetchWithTrace(input, init),
};

let appCache: PresignCache | null = null;

/** The app-wide presign cache, made on first use. */
export function appPresignCache(): PresignCache {
  if (appCache === null) {
    appCache = new PresignCache(appPresignDeps, undefined, undefined, localThumbnailUrlStore);
  }
  return appCache;
}

/** Whether the asset-read endpoint is configured (pictures can be signed at all). */
export const APP_PRESIGN_ENABLED =
  env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';
