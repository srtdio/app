// Where the preview places the post. The post's format decides it: reel /
// story / short are fixed full-screen placements, single image / carousel /
// thread / text are feed posts. Only a plain video on Instagram or Facebook
// leaves the placement open (the platform shows it as a Reel, a Story or in
// the feed), so only then the preview offers Reel / Story / Feed chips. Pure.

export type Placement = 'reel' | 'story' | 'feed';

/** The chip labels: the platform size names (src/lib/platform-specs.ts). */
export const PLACEMENT_LABEL: Readonly<Record<Placement, string>> = {
  reel: 'Reel',
  story: 'Story',
  feed: 'Feed',
};

const OPEN_PLACEMENT_PLATFORMS: readonly string[] = ['instagram', 'facebook'];
const PLACEMENTS: readonly Placement[] = ['reel', 'story', 'feed'];

/** The chips to offer, or null when the format fixes the placement. */
export function placementOptions(platform: string, format: string): readonly Placement[] | null {
  return format === 'video' && OPEN_PLACEMENT_PLATFORMS.includes(platform) ? PLACEMENTS : null;
}

/** The placement the preview opens on: the format's own, else feed. */
export function defaultPlacement(format: string): Placement {
  if (format === 'reel' || format === 'short') return 'reel';
  if (format === 'story') return 'story';
  return 'feed';
}

/**
 * The format the frame rule (frameFor) reads for a picked placement: a plain
 * video placed as a Reel or Story is drawn as that format; Feed keeps the
 * post's own format. A format with no open placement is returned as is.
 */
export function placementFormat(platform: string, format: string, placement: Placement): string {
  if (placementOptions(platform, format) === null) return format;
  if (placement === 'reel') return 'reel';
  if (placement === 'story') return 'story';
  return format;
}
