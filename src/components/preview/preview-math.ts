// Pure helpers over src/lib/platform-specs.ts: spec lookup, the format's
// default size, and the crop math the preview panel shows. No DOM, no network.

import {
  formatDefaultSize,
  frameFor,
  PLATFORM_SPECS,
  VERTICAL_FRAME,
  type FrameMedia,
  type PlatformSize,
  type PlatformSpec,
} from '@/lib/platform-specs';
import { isPostPlatform, type PostPlatform } from '@srtdio/posts';

export { formatDefaultSize };

export type PreviewMedia = 'image' | 'video';

/** The spec for a platform key, or null for an unknown key. */
export function specFor(platform: string): PlatformSpec | null {
  return isPostPlatform(platform) ? PLATFORM_SPECS[platform] : null;
}

/** The sizes a platform shows for one media kind (empty when it takes none). */
export function sizesFor(platform: string, media: PreviewMedia): readonly PlatformSize[] {
  return specFor(platform)?.[media] ?? [];
}

/**
 * The size the preview opens on for attached media of one kind: the size in
 * that kind's list nearest the post's frame (frameFor, so the panel opens on
 * what the post page shows); ties keep the list's default.
 */
export function defaultSizeFor(
  platform: PostPlatform,
  format: string,
  media: PreviewMedia,
  dims: { w: number; h: number } | null = null,
): PlatformSize | null {
  const list = PLATFORM_SPECS[platform][media];
  const fallback = list.find((size) => size.isDefault === true) ?? list[0] ?? null;
  const first: FrameMedia = { kind: media, w: dims?.w ?? null, h: dims?.h ?? null };
  const frame = frameFor(platform, format, first);
  const byFormat = formatDefaultSize(platform, format);
  if (frame === null) return fallback;
  // Prefer the format's own size (Reel vs Story share 9:16) when it is in this list.
  if (byFormat !== null && byFormat.media === media && frame.source !== 'media')
    return byFormat.size;
  let best = fallback;
  let bestGap = best === null ? Infinity : Math.abs(Math.log(best.w / best.h / frame.ratio));
  for (const size of list) {
    const gap = Math.abs(Math.log(size.w / size.h / frame.ratio));
    if (gap < bestGap - 1e-9) {
      best = size;
      bestGap = gap;
    }
  }
  return best;
}

/** The ratio a format's frame uses before any media is known (w / h), or null for no frame. */
export function formatFrameRatio(platform: string, format: string): number | null {
  return frameFor(platform, format, null)?.ratio ?? null;
}

// The ratios platforms publish; a size within 1% reads as the published one
// (1200 x 630 is 1.905, published as 1.91:1).
const NAMED_RATIOS: ReadonlyArray<readonly [number, string]> = [
  [1, '1:1'],
  [4 / 5, '4:5'],
  [3 / 4, '3:4'],
  [9 / 16, '9:16'],
  [16 / 9, '16:9'],
  [1.91, '1.91:1'],
];

/** A readable ratio for a size, e.g. "4:5", "9:16", "1.91:1". */
export function ratioLabel(w: number, h: number): string {
  const named = NAMED_RATIOS.find(([r]) => Math.abs(w / h / r - 1) < 0.01);
  if (named !== undefined) return named[1];
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  const rw = w / d;
  const rh = h / d;
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  const r = w / h;
  return r >= 1 ? `${trim(r)}:1` : `1:${trim(1 / r)}`;
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** The size picker's second line: "1080 x 1350 · 4:5". */
export function sizeMeta(size: PlatformSize): string {
  return `${size.w} x ${size.h} · ${ratioLabel(size.w, size.h)}`;
}

/** The part of the original shown, as fractions of its width and height. */
export interface CropWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CropResult =
  | { kind: 'fits'; window: CropWindow }
  | { kind: 'cut'; pct: number; from: 'sides' | 'top and bottom'; window: CropWindow }
  | { kind: 'bands'; window: CropWindow };

const FULL: CropWindow = { x: 0, y: 0, w: 1, h: 1 };

/**
 * How a size frames media of width x height. feed / vertical / story crop to the
 * size's ratio from the centre; bands / letterbox show it whole in the 9:16
 * frame. A cut under 0.5% rounds to "fits".
 */
export function cropFor(media: { w: number; h: number }, size: PlatformSize): CropResult {
  if (media.w <= 0 || media.h <= 0) return { kind: 'fits', window: FULL };
  const mediaR = media.w / media.h;
  if (size.layout === 'bands' || size.layout === 'letterbox') {
    const frameR = frameRatio(size);
    return Math.abs(mediaR / frameR - 1) < 0.005
      ? { kind: 'fits', window: FULL }
      : { kind: 'bands', window: FULL };
  }
  const targetR = size.w / size.h;
  if (mediaR > targetR) {
    const shown = targetR / mediaR;
    const pct = Math.round((1 - shown) * 100);
    if (pct === 0) return { kind: 'fits', window: FULL };
    return {
      kind: 'cut',
      pct,
      from: 'sides',
      window: { x: (1 - shown) / 2, y: 0, w: shown, h: 1 },
    };
  }
  const shown = mediaR / targetR;
  const pct = Math.round((1 - shown) * 100);
  if (pct === 0) return { kind: 'fits', window: FULL };
  return {
    kind: 'cut',
    pct,
    from: 'top and bottom',
    window: { x: 0, y: (1 - shown) / 2, w: 1, h: shown },
  };
}

/** The line under the crop box. */
export function cropLine(result: CropResult): string {
  if (result.kind === 'fits') return 'Fits exactly';
  if (result.kind === 'bands') return 'Shown with bands';
  return `${result.pct}% cut from ${result.from}`;
}

/**
 * The ratio of the mock frame: for bands / letterbox the frame the media sits
 * in (its own frame, else 9:16), else the size's own.
 */
export function frameRatio(size: PlatformSize): number {
  if (size.layout === 'bands' || size.layout === 'letterbox') {
    const f = size.frame ?? VERTICAL_FRAME;
    return f.w / f.h;
  }
  return size.w / size.h;
}

/** The label of the panel's first size: the frame this post renders in. */
export const THIS_POST = 'This post';

/**
 * The frame this post renders in on the post page (frameFor), as a panel size,
 * so the panel opens on exactly what the page shows. Cropping frames are feed /
 * story / vertical; fitting frames are bands (blurred) or letterbox (black)
 * around the media's own ratio. null when the format has no media box.
 */
export function postSize(
  platform: string,
  format: string,
  media: PreviewMedia,
  dims: { w: number; h: number } | null,
): PlatformSize | null {
  const frame = frameFor(platform, format, { kind: media, w: dims?.w ?? null, h: dims?.h ?? null });
  if (frame === null) return null;
  const r = frame.ratio;
  const listed = sizesFor(platform, media).find((s) => Math.abs(s.w / s.h / r - 1) < 0.005);
  const own = dims !== null && Math.abs(dims.w / dims.h / r - 1) < 0.005 ? dims : null;
  const box =
    own ??
    (listed !== undefined
      ? { w: listed.w, h: listed.h }
      : r >= 1
        ? { w: Math.round(1080 * r), h: 1080 }
        : { w: 1080, h: Math.round(1080 / r) });
  if (frame.fit === 'contain') {
    const frameBox =
      r >= 1 ? { w: Math.round(1080 * r), h: 1080 } : { w: 1080, h: Math.round(1080 / r) };
    return {
      label: THIS_POST,
      w: frameBox.w,
      h: frameBox.h,
      layout: frame.bands === 'blur' ? 'bands' : 'letterbox',
      frame: frameBox,
      ...(frame.source !== 'fixed' ? { feedCard: true as const } : {}),
    };
  }
  const layout = format === 'story' ? 'story' : r < 0.6 ? 'vertical' : 'feed';
  return { label: THIS_POST, w: box.w, h: box.h, layout };
}

/** Lines of caption each layout shows before "more". */
export function captionClampLines(size: PlatformSize): number {
  return size.layout === 'feed' ? 3 : 2;
}
