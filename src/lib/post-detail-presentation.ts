// Presentation helpers for the post-detail header: human platform/format labels
// and the per-stage status line. Pure and unit tested; `now` is passed in so the
// day readings stay deterministic. The label maps are the known values;
// an unknown value title-cases its raw token rather than rendering blank.

import type { Stage } from '@srtdio/posts';
import { formatWhen } from './time';
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
 * the app's one past-time format (formatWhen: "10:27 AM" today, "Yesterday",
 * "Mon", "11 Jun", "11 Jun 2025") on the viewer's clock (`timeZone` is for tests).
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
      return `Updated ${formatWhen(updatedAt, now, timeZone)}`;
    case 'review':
      return `In review · ${formatWhen(stageEnteredAt, now, timeZone)}`;
    case 'approved':
      return `Approved ${formatWhen(stageEnteredAt, now, timeZone)}`;
    case 'parked':
      return `Parked ${formatWhen(stageEnteredAt, now, timeZone)}`;
    case 'rejected':
      return `Rejected ${formatWhen(stageEnteredAt, now, timeZone)}`;
  }
}
