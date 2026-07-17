// Per-platform feed bounds and the pure fit/crop verdict the lightbox's Feed
// lens renders. Keyed by the raw workspaces.platform string; nothing here knows
// about workspaces or React. An unknown or null platform yields null everywhere,
// which the UI reads as "no feed lens for this workspace".

/** The feed-frame bounds one platform enforces on an image in its feed. */
export interface PlatformFeedSpec {
  /** Human label ("LinkedIn"); used in the chip and the skeleton card. */
  label: string;
  /** Tallest allowed frame as width/height (LinkedIn: 4:5 = 0.8). */
  minRatio: number;
  /** Display label for the tall bound. */
  minRatioLabel: string;
  /** Widest allowed frame as width/height (LinkedIn: 1.91:1). */
  maxRatio: number;
  /** Display label for the wide bound. */
  maxRatioLabel: string;
}

export const PLATFORM_FEED_SPECS: Readonly<Record<string, PlatformFeedSpec>> = {
  linkedin: {
    label: 'LinkedIn',
    minRatio: 4 / 5,
    minRatioLabel: '4:5',
    maxRatio: 1.91,
    maxRatioLabel: '1.91:1',
  },
};

/** The spec for a workspace platform, or null when unknown/absent. */
export function specFor(platform: string | null | undefined): PlatformFeedSpec | null {
  if (platform === null || platform === undefined) return null;
  return PLATFORM_FEED_SPECS[platform] ?? null;
}

/** How an image of a given size lands in one platform's feed frame. */
export interface FeedVerdict {
  fit: 'fits' | 'crops-to';
  /** The rendered frame ratio: the image's own when it fits, else the clamped bound. */
  ratio: number;
  /** Display label for `ratio` ("4:5", "1.91:1"). */
  ratioLabel: string;
  /** Axis losing pixels: 'y' trims top/bottom (too tall), 'x' trims the sides. */
  cropAxis: 'x' | 'y' | null;
  /** Percent of the image's pixels outside the frame; 0 when it fits. */
  percentLost: number;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * A compact display ratio for arbitrary pixel dimensions: small exact ratios
 * reduce ("1080x1350" -> "4:5"), anything unwieldy falls back to a decimal
 * against 1 ("1.78:1"). Pure.
 */
export function formatRatio(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '';
  const g = gcd(Math.round(width), Math.round(height));
  const a = Math.round(width) / g;
  const b = Math.round(height) / g;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  const r = width / height;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

/**
 * The feed verdict for an image on a platform: fits when its ratio sits inside
 * the platform's bounds, otherwise crops-to the nearer bound with the axis and
 * the exact percent of pixels lost. Null for an unknown/null platform or
 * non-positive dimensions. Pure.
 */
export function verdict(
  width: number,
  height: number,
  platform: string | null | undefined,
): FeedVerdict | null {
  const spec = specFor(platform);
  if (spec === null) return null;
  return verdictForSpec(width, height, spec);
}

/** As {@link verdict}, against an already-resolved spec. Pure. */
export function verdictForSpec(
  width: number,
  height: number,
  spec: PlatformFeedSpec,
): FeedVerdict | null {
  if (!(width > 0) || !(height > 0)) return null;
  const r = width / height;
  if (r < spec.minRatio) {
    return {
      fit: 'crops-to',
      ratio: spec.minRatio,
      ratioLabel: spec.minRatioLabel,
      cropAxis: 'y',
      percentLost: (1 - r / spec.minRatio) * 100,
    };
  }
  if (r > spec.maxRatio) {
    return {
      fit: 'crops-to',
      ratio: spec.maxRatio,
      ratioLabel: spec.maxRatioLabel,
      cropAxis: 'x',
      percentLost: (1 - spec.maxRatio / r) * 100,
    };
  }
  return {
    fit: 'fits',
    ratio: r,
    ratioLabel: formatRatio(width, height),
    cropAxis: null,
    percentLost: 0,
  };
}
