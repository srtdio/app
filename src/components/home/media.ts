// Homepage media (videos, posters, images) is served from the site CDN. The
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
  poster: string;
  /** Seconds into the clip of its first real (non-blank) frame. Omitted means 0. */
  startAt?: number;
}

// First real frame per clip, measured with ffmpeg signalstats on the v1 files:
// the first frame whose mean luma moves at least 2 (of 255) away from the flat
// opening frame. Clips not listed already open on a real frame.
const CLIP_START_AT: Readonly<Record<string, number>> = {
  'problems-m': 0.167,
  'problems-d': 0.167,
};

/** <name>.mp4 with its <name>.webp poster and its first real frame. */
export function clipFor(base: string | null, name: string): Clip | null {
  const src = mediaUrl(base, `${name}.mp4`);
  const poster = mediaUrl(base, `${name}.webp`);
  if (!src || !poster) return null;
  const startAt = CLIP_START_AT[name];
  return startAt ? { src, poster, startAt } : { src, poster };
}
