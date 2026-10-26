// Verified 16 Oct 2026 from published platform spec guides; update here only.
//
// The preview sizes each platform shows, keyed by the platform keys in
// @srtdio/posts (POST_PLATFORMS). Each size is {label, w, h, layout}. One pure
// frame rule (frameFor) sits at the bottom; the post gallery, the create sheet
// and the preview panel all size their media box with it. Crop maths lives in
// src/components/preview/preview-math.ts.

import { isPostPlatform, POST_FORMATS, type PostFormat, type PostPlatform } from '@srtdio/posts';
import { formatNeedsMedia } from '@/lib/induction';

/**
 * How the platform frames the media:
 * - feed: an in-feed card; the media is cropped to the size's ratio.
 * - vertical: full-screen 9:16 player; cropped to fill.
 * - story: full-screen 9:16 story; cropped to fill.
 * - bands: shown whole in a 9:16 frame with blurred bands (never cropped).
 * - letterbox: shown whole in a 9:16 frame with black bands (never cropped).
 */
export type PreviewLayout = 'feed' | 'vertical' | 'story' | 'bands' | 'letterbox';

export interface PlatformSize {
  label: string;
  w: number;
  h: number;
  layout: PreviewLayout;
  /** The size shown first when nothing else picks one. */
  isDefault?: true;
  /** bands / letterbox only: the frame the media sits in (default 9:16). */
  frame?: { w: number; h: number };
  /** letterbox only: draw it as an in-feed card (Threads), not full-screen. */
  feedCard?: true;
}

export interface PlatformSpec {
  /** Image sizes; empty when the platform takes no image (see imageUnsupported). */
  image: readonly PlatformSize[];
  video: readonly PlatformSize[];
  /** Shown instead of a preview when an image is attached but the platform takes none. */
  imageUnsupported?: string;
  /** One-line platform notes shown under the size picker. */
  imageNote?: string;
  videoNote?: string;
  /** PDF/document posts: pages are shown as-is, never cropped. */
  documentNote?: string;
  /**
   * Feed posts (single image, carousel, feed video, thread): the ratios (w / h)
   * the platform shows per media kind, and what happens outside the range:
   * 'crop' = centre crop to the nearest end, 'bands' = fit inside with bands,
   * never cut. Absent = no range data (the format's default size is used).
   */
  feed?: { image: RatioRange; video: RatioRange; outside: 'crop' | 'bands' };
  /**
   * Full-screen-only platforms (TikTok, YouTube Shorts): every post sits in a
   * 9:16 frame and any other ratio is fit inside it with these bands, never cut.
   */
  verticalBands?: 'black' | 'blur';
}

/** An accepted ratio range, as w / h. */
export interface RatioRange {
  min: number;
  max: number;
}

/** The 9:16 frame bands and letterbox layouts sit in. */
export const VERTICAL_FRAME = { w: 1080, h: 1920 } as const;

export const PLATFORM_SPECS: Readonly<Record<PostPlatform, PlatformSpec>> = {
  instagram: {
    image: [
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed', isDefault: true },
      { label: 'Tall', w: 1080, h: 1440, layout: 'feed' },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
      { label: 'Landscape', w: 1080, h: 566, layout: 'feed' },
    ],
    video: [
      { label: 'Reel', w: 1080, h: 1920, layout: 'vertical', isDefault: true },
      { label: 'Story', w: 1080, h: 1920, layout: 'story' },
      { label: 'Feed', w: 1080, h: 1350, layout: 'feed' },
    ],
    imageNote:
      'Accepted range is 1.91:1 to 3:4; anything outside is cropped. In a carousel the first slide sets the ratio for all slides.',
    feed: {
      image: { min: 3 / 4, max: 1.91 },
      video: { min: 3 / 4, max: 1.91 },
      outside: 'crop',
    },
  },
  facebook: {
    image: [
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed', isDefault: true },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
      { label: 'Landscape', w: 1200, h: 630, layout: 'feed' },
    ],
    video: [
      { label: 'Feed', w: 1080, h: 1350, layout: 'feed', isDefault: true },
      { label: 'Feed square', w: 1080, h: 1080, layout: 'feed' },
      { label: 'Reel', w: 1080, h: 1920, layout: 'vertical' },
      { label: 'Story', w: 1080, h: 1920, layout: 'story' },
    ],
    feed: {
      image: { min: 4 / 5, max: 1.91 },
      video: { min: 4 / 5, max: 1.91 },
      outside: 'crop',
    },
  },
  linkedin: {
    image: [
      { label: 'Landscape', w: 1200, h: 627, layout: 'feed' },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed', isDefault: true },
    ],
    video: [
      { label: 'Landscape', w: 1920, h: 1080, layout: 'feed', isDefault: true },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed' },
      { label: 'Vertical', w: 1080, h: 1920, layout: 'feed' },
    ],
    videoNote: 'Accepted range is 1:2.4 to 2.4:1.',
    feed: {
      image: { min: 4 / 5, max: 1.91 },
      video: { min: 1 / 2.4, max: 2.4 },
      outside: 'crop',
    },
    documentNote: 'Document pages are shown as-is, with no crop.',
  },
  x: {
    image: [
      { label: 'Landscape', w: 1600, h: 900, layout: 'feed', isDefault: true },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed' },
    ],
    video: [
      { label: 'Landscape', w: 1920, h: 1080, layout: 'feed', isDefault: true },
      { label: 'Vertical', w: 1080, h: 1920, layout: 'feed' },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
    ],
    imageNote: 'With more than one image, each is cropped from the centre.',
    feed: {
      image: { min: 4 / 5, max: 16 / 9 },
      video: { min: 4 / 5, max: 16 / 9 },
      outside: 'crop',
    },
  },
  youtube_shorts: {
    image: [],
    video: [{ label: 'Short', w: 1080, h: 1920, layout: 'bands', isDefault: true }],
    imageUnsupported: 'Shorts are video only.',
    verticalBands: 'blur',
    videoNote: 'Horizontal and square videos are shown whole, with blurred bands top and bottom.',
  },
  tiktok: {
    image: [{ label: 'Vertical', w: 1080, h: 1920, layout: 'letterbox', isDefault: true }],
    video: [
      { label: 'Vertical', w: 1080, h: 1920, layout: 'letterbox', isDefault: true },
      { label: 'Landscape', w: 1920, h: 1080, layout: 'letterbox' },
      { label: 'Square', w: 1080, h: 1080, layout: 'letterbox' },
    ],
    imageNote: 'Photo posts use one ratio for all slides.',
    verticalBands: 'black',
  },
  threads: {
    image: [
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed', isDefault: true },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
    ],
    video: [
      { label: 'Vertical', w: 1080, h: 1920, layout: 'vertical', isDefault: true },
      { label: 'Portrait', w: 1080, h: 1350, layout: 'feed' },
      { label: 'Square', w: 1080, h: 1080, layout: 'feed' },
    ],
    imageNote: 'A carousel keeps the same ratio across slides. Nothing is cropped.',
    feed: {
      image: { min: 9 / 16, max: 1.91 },
      video: { min: 9 / 16, max: 1.91 },
      outside: 'bands',
    },
  },
};

/**
 * The size a format starts on: which media list, and which size in it by label
 * ('default' = the list's isDefault size). null = the format takes no media
 * (text, link), so there is no frame.
 *
 * reel / story / short and every TikTok video land on 9:16; single image,
 * carousel and thread land on the platform's default image size; video lands on
 * the platform's default video size.
 */
const FORMAT_DEFAULT_SIZE: Readonly<
  Record<PostFormat, { media: 'image' | 'video'; size: string } | null>
> = {
  text: null,
  link: null,
  single_image: { media: 'image', size: 'default' },
  carousel: { media: 'image', size: 'default' },
  thread: { media: 'image', size: 'default' },
  video: { media: 'video', size: 'default' },
  reel: { media: 'video', size: 'Reel' },
  story: { media: 'video', size: 'Story' },
  short: { media: 'video', size: 'Short' },
};

function listDefault(list: readonly PlatformSize[]): PlatformSize | null {
  return list.find((size) => size.isDefault === true) ?? list[0] ?? null;
}

function isPostFormat(value: string): value is PostFormat {
  return (POST_FORMATS as readonly string[]).includes(value);
}

/**
 * The size a format starts on for the platform (FORMAT_DEFAULT_SIZE), or null
 * when the format takes no media or the platform has no matching list.
 */
export function formatDefaultSize(
  platform: string,
  format: string,
): { media: 'image' | 'video'; size: PlatformSize } | null {
  if (!isPostPlatform(platform) || !isPostFormat(format)) return null;
  const rule = FORMAT_DEFAULT_SIZE[format];
  if (rule === null) return null;
  const list = PLATFORM_SPECS[platform][rule.media];
  const size =
    rule.size === 'default'
      ? listDefault(list)
      : (list.find((s) => s.label === rule.size) ?? listDefault(list));
  return size === null ? null : { media: rule.media, size };
}

/** Formats always shown full-screen at 9:16 and cropped to fill. */
const FIXED_VERTICAL_FORMATS: readonly string[] = ['reel', 'story', 'short'];

/** The first media of a post, for the frame rule. */
export interface FrameMedia {
  kind: 'image' | 'video' | 'other';
  /** Intrinsic size; null until stored or measured. */
  w: number | null;
  h: number | null;
}

/**
 * The media box a post renders in. ratio is w / h. fit 'cover' fills the frame
 * with a centre crop; 'contain' fits the whole media inside it, with bands
 * where the ratios differ. bands names how those bands look.
 */
export interface Frame {
  ratio: number;
  source: 'fixed' | 'media' | 'default';
  fit: 'cover' | 'contain';
  bands: 'none' | 'black' | 'blur';
}

const VERTICAL = VERTICAL_FRAME.w / VERTICAL_FRAME.h;

/**
 * The one frame rule, shared by the post page gallery, the create sheet and
 * the preview panel.
 * - text / link: null (no media box).
 * - Media-optional formats (formatNeedsMedia false, e.g. thread): null until a
 *   photo or video is attached, so there is never an empty frame for them.
 * - TikTok and YouTube Shorts: always 9:16; other ratios are fit inside with
 *   bands (black / blurred), never cropped.
 * - reel / story / short elsewhere: 9:16, cropped to fill.
 * - Feed formats: the first media's own ratio clamped into the platform's feed
 *   range. Outside it, Instagram / Facebook / LinkedIn / X crop from the centre;
 *   Threads fits the media inside the clamped frame with bands, never cutting.
 *   A carousel passes its first slide, so every slide shares that frame.
 * - No range data, or the first media's size not known yet: the format's
 *   default size, cropped to fill.
 */
export function frameFor(platform: string, format: string, first: FrameMedia | null): Frame | null {
  if (!isPostPlatform(platform) || !isPostFormat(format)) return null;
  if (FORMAT_DEFAULT_SIZE[format] === null) return null;
  if (!formatNeedsMedia(format) && (first === null || first.kind === 'other')) return null;
  const spec = PLATFORM_SPECS[platform];
  if (spec.verticalBands !== undefined) {
    return { ratio: VERTICAL, source: 'fixed', fit: 'contain', bands: spec.verticalBands };
  }
  if (FIXED_VERTICAL_FORMATS.includes(format)) {
    return { ratio: VERTICAL, source: 'fixed', fit: 'cover', bands: 'none' };
  }
  const range =
    first !== null && first.kind !== 'other' && spec.feed !== undefined
      ? spec.feed[first.kind]
      : undefined;
  if (
    range !== undefined &&
    spec.feed !== undefined &&
    first !== null &&
    first.w !== null &&
    first.h !== null &&
    first.w > 0 &&
    first.h > 0
  ) {
    const own = first.w / first.h;
    const ratio = Math.min(range.max, Math.max(range.min, own));
    if (spec.feed.outside === 'bands') {
      return { ratio, source: 'media', fit: 'contain', bands: ratio === own ? 'none' : 'black' };
    }
    return { ratio, source: 'media', fit: 'cover', bands: 'none' };
  }
  const fallback = formatDefaultSize(platform, format);
  if (fallback === null) return null;
  // Threads never cuts: until the media's size is known it is fit, not cropped.
  return spec.feed?.outside === 'bands'
    ? {
        ratio: fallback.size.w / fallback.size.h,
        source: 'default',
        fit: 'contain',
        bands: 'black',
      }
    : { ratio: fallback.size.w / fallback.size.h, source: 'default', fit: 'cover', bands: 'none' };
}
