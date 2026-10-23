// The caption length each platform allows, in one place. The counter under the
// caption reads it; going over turns the counter the bad colour but never
// blocks saving. Pure so it unit-tests without a DOM.

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

const GROUPING = new Intl.NumberFormat('en-IN');

/** A count in Indian digit grouping: 63206 reads "63,206", 100000 reads "1,00,000". */
export function groupDigits(value: number): string {
  return GROUPING.format(value);
}

/** The counter text: "{count} / {limit}". */
export function captionCounterText(count: number, limit: number): string {
  return `${groupDigits(count)} / ${groupDigits(limit)}`;
}

/** True once the caption runs past the platform's limit. */
export function captionOverLimit(count: number, limit: number): boolean {
  return count > limit;
}
