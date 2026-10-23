// The caption and title lengths in one place. The New post sheet counts the
// caption against the app-wide cap (4,000, the server's caption_too_long) and
// refuses to save past it; the per-platform limits stay listed for reference.
// Pure so it unit-tests without a DOM.

import type { PostPlatform } from '@srtdio/posts';

/** Characters a caption may hold, per platform. */
export const CAPTION_LIMITS: Record<PostPlatform, number> = {
  instagram: 2200,
  linkedin: 3000,
  x: 280,
  threads: 500,
  facebook: 63206,
  tiktok: 4000,
  youtube_shorts: 5000,
};

/** The most characters any caption may hold (the server refuses more). */
export const CAPTION_MAX = 4000;

/** The most characters a title may hold. */
export const TITLE_MAX = 200;

/** The title counter shows from this many characters. */
export const TITLE_COUNTER_FROM = 180;

const GROUPING = new Intl.NumberFormat('en-US');

/** A count in US digit grouping: 63206 reads "63,206", 100000 reads "100,000". */
export function groupDigits(value: number): string {
  return GROUPING.format(value);
}

/** The counter text: "{count} / {limit}". */
export function captionCounterText(count: number, limit: number): string {
  return `${groupDigits(count)} / ${groupDigits(limit)}`;
}

/** True once the caption runs past the limit. */
export function captionOverLimit(count: number, limit: number): boolean {
  return count > limit;
}

/** True once a caption runs past the app-wide cap: saving is refused. */
export function captionTooLong(caption: string): boolean {
  return caption.length > CAPTION_MAX;
}

/** Whether the title counter shows: from 180 characters. */
export function titleCounterVisible(title: string): boolean {
  return title.length >= TITLE_COUNTER_FROM;
}
