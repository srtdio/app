// Presentation helpers for the post-detail header: human platform/format labels
// and the per-stage status line. Pure and unit tested; `now` is passed in so the
// relative readings stay deterministic. The label maps are the known values;
// an unknown value title-cases its raw token rather than rendering blank.

import type { Stage } from '@srtdio/posts';
import { formatDate, formatRelative } from './time';
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
 * the last edit (updated_at); review tracks how long it has waited
 * (stage_entered_at); approved/parked/rejected read as a dated event, its day
 * read on the viewer's clock (`timeZone` is for tests).
 */
export function postStatusLine(
  stage: Stage,
  updatedAt: string,
  stageEnteredAt: string,
  now: Date,
  timeZone?: string,
): string {
  switch (stage) {
    case 'draft':
      return `Updated ${formatRelative(updatedAt, now)}`;
    case 'review':
      return `In review · ${formatRelative(stageEnteredAt, now)}`;
    case 'approved':
      return `Approved ${formatDate(stageEnteredAt, now, timeZone)}`;
    case 'parked':
      return `Parked ${formatDate(stageEnteredAt, now, timeZone)}`;
    case 'rejected':
      return `Rejected ${formatDate(stageEnteredAt, now, timeZone)}`;
  }
}
