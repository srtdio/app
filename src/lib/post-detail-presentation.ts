// Presentation helpers for the post-detail header: human platform/format labels
// and the per-stage status line. Pure and unit tested; `now` is passed in so the
// day readings stay deterministic. The label maps are the known values;
// an unknown value title-cases its raw token rather than rendering blank.

import type { Stage } from '@srtdio/posts';
import { formatAgo } from './time';
import { postFormatLabel } from './post-format';

const PLATFORM_LABELS = {
  linkedin: 'LinkedIn',
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
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

/** A format's display name; reads the one map in ./post-format (create-sheet labels). */
export function formatLabel(f: string, platform?: string | null): string {
  return postFormatLabel(f, platform);
}

/**
 * The single-line status read for the post-detail header, per stage. Draft tracks
 * the last edit (updated_at); review tracks when it entered review
 * (stage_entered_at); approved/parked/rejected read as an event. Every time is
 * short (formatAgo: "just now", "5m", "3h", "Yesterday", "Mon", "2 Nov")
 * against `now`.
 */
export function postStatusLine(
  stage: Stage,
  updatedAt: string,
  stageEnteredAt: string,
  now: Date,
): string {
  switch (stage) {
    case 'draft':
      return `Updated ${formatAgo(updatedAt, now)}`;
    case 'review':
      return `In review · ${formatAgo(stageEnteredAt, now)}`;
    case 'approved':
      return `Approved ${formatAgo(stageEnteredAt, now)}`;
    case 'parked':
      return `Parked ${formatAgo(stageEnteredAt, now)}`;
    case 'rejected':
      return `Rejected ${formatAgo(stageEnteredAt, now)}`;
  }
}
