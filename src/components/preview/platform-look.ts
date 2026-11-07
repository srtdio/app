// Each platform's preview look: the named pv-* colour tokens
// (tailwind.config.ts) its feed card is drawn in, and the order of its static
// action glyphs. Full-screen placements (Reel, Story, TikTok, Shorts) share
// the black pv-screen look. Never a logo or a wordmark. Pure data.

import type { PostPlatform } from '@srtdio/posts';

/** The feed card layouts: one per platform that has a feed. */
export type FeedFamily = 'instagram' | 'facebook' | 'linkedin' | 'x' | 'threads';

export interface FeedLook {
  /** The page ground around the card (Facebook, LinkedIn), or null when the card is the page. */
  page: string | null;
  ink: string;
  ink2: string;
  /** Hairline colour (border-*). */
  line: string;
}

export const FEED_LOOK: Readonly<Record<FeedFamily, FeedLook>> = {
  instagram: {
    page: null,
    ink: 'text-pv-ig-ink',
    ink2: 'text-pv-ig-ink-2',
    line: 'border-pv-ig-line',
  },
  facebook: {
    page: 'bg-pv-fb-page',
    ink: 'text-pv-fb-ink',
    ink2: 'text-pv-fb-ink-2',
    line: 'border-pv-fb-line',
  },
  linkedin: {
    page: 'bg-pv-li-page',
    ink: 'text-pv-li-ink',
    ink2: 'text-pv-li-ink-2',
    line: 'border-pv-li-line',
  },
  x: { page: null, ink: 'text-pv-x-ink', ink2: 'text-pv-x-ink-2', line: 'border-pv-x-line' },
  threads: {
    page: null,
    ink: 'text-pv-th-ink',
    ink2: 'text-pv-th-ink-2',
    line: 'border-pv-th-line',
  },
};

/** TikTok and YouTube Shorts have no feed card: every post is full screen. */
export function fullScreenOnly(platform: string): boolean {
  return platform === 'tiktok' || platform === 'youtube_shorts';
}

/** The feed card layout for a platform (full-screen-only platforms never draw one). */
export function feedFamily(platform: PostPlatform): FeedFamily {
  switch (platform) {
    case 'facebook':
    case 'linkedin':
    case 'x':
    case 'threads':
      return platform;
    default:
      return 'instagram';
  }
}

/** The static action glyphs, in the platform's order (drawn inert, aria-hidden). */
export type ActionGlyph = 'like' | 'comment' | 'share' | 'send' | 'repost' | 'save';

export const FEED_ACTIONS: Readonly<
  Record<
    FeedFamily,
    { lead: readonly ActionGlyph[]; trail: readonly ActionGlyph[]; spread: boolean }
  >
> = {
  instagram: { lead: ['like', 'comment', 'send'], trail: ['save'], spread: false },
  facebook: { lead: ['like', 'comment', 'share'], trail: [], spread: true },
  linkedin: { lead: ['like', 'comment', 'repost', 'send'], trail: [], spread: true },
  x: { lead: ['comment', 'repost', 'like', 'save'], trail: [], spread: true },
  threads: { lead: ['like', 'comment', 'repost', 'send'], trail: [], spread: false },
};

/** The right rail of a full-screen post (Reel, TikTok, Shorts). */
export const RAIL_ACTIONS: readonly ActionGlyph[] = ['like', 'comment', 'send', 'save'];
/** The row at the foot of a Story. */
export const STORY_ACTIONS: readonly ActionGlyph[] = ['like', 'send'];

/** Which feed layouts show the post time in the header (Instagram shows none). */
export function headerShowsTime(family: FeedFamily): boolean {
  return family !== 'instagram';
}

/** X and Threads draw the avatar in its own column, the post beside it. */
export function avatarColumn(family: FeedFamily): boolean {
  return family === 'x' || family === 'threads';
}

/** Facebook, LinkedIn, X and Threads put the caption above the media; Instagram below. */
export function captionFirst(family: FeedFamily): boolean {
  return family !== 'instagram';
}
