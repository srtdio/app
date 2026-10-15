// Verified 16 Oct 2026 from published platform spec guides; update here only.
//
// Config only: the preview sizes each platform shows, keyed by the platform
// keys in @srtdio/posts (POST_PLATFORMS). Each size is {label, w, h, layout}.
// Logic that reads this (crop math, default lookup) lives in
// src/components/preview/preview-math.ts.

import type { PostFormat, PostPlatform } from '@srtdio/posts';

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
  },
  youtube_shorts: {
    image: [],
    video: [{ label: 'Short', w: 1080, h: 1920, layout: 'bands', isDefault: true }],
    imageUnsupported: 'Shorts are video only.',
    videoNote: 'Horizontal and square videos are shown whole, with blurred bands top and bottom.',
  },
  tiktok: {
    image: [{ label: 'Vertical', w: 1080, h: 1920, layout: 'vertical', isDefault: true }],
    video: [
      { label: 'Vertical', w: 1080, h: 1920, layout: 'vertical', isDefault: true },
      { label: 'Landscape', w: 1920, h: 1080, layout: 'letterbox' },
      { label: 'Square', w: 1080, h: 1080, layout: 'letterbox' },
    ],
    imageNote: 'Photo posts use one ratio for all slides.',
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
    imageNote: 'A carousel keeps the same ratio across slides.',
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
export const FORMAT_DEFAULT_SIZE: Readonly<
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
