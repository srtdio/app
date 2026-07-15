// Presentation helpers for the post-detail header: human platform/format labels
// and the per-stage status line. Pure and unit tested; `now` is passed in so the
// relative readings stay deterministic. The label maps are the known v2 values;
// an unknown value title-cases its raw token rather than rendering blank.

import type { Stage } from '@srtdio/posts';
import { relativeShort, shortDate } from './relative-time';

const PLATFORM_LABELS = {
  linkedin: 'LinkedIn',
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
} as Record<string, string>;

const FORMAT_LABELS = {
  text: 'Text',
  single_image: 'Single Image',
  carousel: 'Carousel',
  video: 'Video',
  link: 'Link',
} as Record<string, string>;

// Title-case a snake_case token for the unknown-value fallback (single_image ->
// Single Image), so a new enum value still reads sensibly before it is mapped.
function titleCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? titleCase(p);
}

export function formatLabel(f: string): string {
  return FORMAT_LABELS[f] ?? titleCase(f);
}

/**
 * The single-line status read for the post-detail header, per stage. Draft tracks
 * the last edit (updated_at); review tracks how long it has waited
 * (stage_entered_at); approved/parked/rejected read as a dated event.
 */
export function postStatusLine(
  stage: Stage,
  updatedAt: string,
  stageEnteredAt: string,
  now: Date,
): string {
  switch (stage) {
    case 'draft': {
      const tok = relativeShort(updatedAt, now);
      return tok === 'just now' ? 'Updated just now' : `Updated ${tok} ago`;
    }
    case 'review': {
      const tok = relativeShort(stageEnteredAt, now);
      return tok === 'just now' ? 'In review · just now' : `In review · ${tok}`;
    }
    case 'approved':
      return `Approved ${shortDate(stageEnteredAt, now)}`;
    case 'parked':
      return `Parked ${shortDate(stageEnteredAt, now)}`;
    case 'rejected':
      return `Rejected ${shortDate(stageEnteredAt, now)}`;
  }
}
