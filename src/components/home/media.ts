// Homepage media (videos and images) is served from the site CDN. The
// base comes from VITE_SITE_MEDIA_URL (production: https://cdn.srtd.io/site/home/v1).
// When it is unset or invalid the homepage renders text and buttons only.

/** Normalises the raw env value: empty or invalid becomes null, no trailing slash. */
export function siteMediaBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

/** Full URL for one manifest file, or null when no media base is configured. */
export function mediaUrl(base: string | null, file: string): string | null {
  return base === null ? null : `${base}/${file}`;
}

// Read directly (not through src/lib/env.ts) so the guest path does not pull in
// zod or require the Supabase vars; env.ts validates the same var for the app.
const rawMediaBase: unknown = import.meta.env.VITE_SITE_MEDIA_URL;
export const HOME_MEDIA_BASE = siteMediaBase(rawMediaBase);

export interface Clip {
  src: string;
}

/** <name>.mp4 on the media base. No poster: ClipVideo shows only decoded frames. */
export function clipFor(base: string | null, name: string): Clip | null {
  const src = mediaUrl(base, `${name}.mp4`);
  return src ? { src } : null;
}
