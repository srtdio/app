// The one source of post format display names. The labels are the create
// sheet's (formatLabel(platform, value) from @srtdio/posts), so the create
// sheet, post page, Pipeline card, chat card and plan item all read the same
// word. Without a platform (or with one the package does not know) a format
// reads its platform-neutral label; an unknown format sentence-cases its raw
// token rather than rendering blank or throwing.

import {
  POST_FORMATS,
  formatLabel as packageFormatLabel,
  isPostPlatform,
  type PostFormat,
} from '@srtdio/posts';

// A platform whose labels are the neutral ones (no platform-specific word).
const NEUTRAL_PLATFORM = 'linkedin';

function isPostFormat(value: string): value is PostFormat {
  return (POST_FORMATS as readonly string[]).includes(value);
}

/** Platform-neutral display name of every known format, from the create-sheet labels. */
export const POST_FORMAT_LABELS: Readonly<Record<PostFormat, string>> = Object.fromEntries(
  POST_FORMATS.map((f) => [f, packageFormatLabel(NEUTRAL_PLATFORM, f)]),
) as Record<PostFormat, string>;

// Sentence-case a snake_case token (photo_grid -> Photo grid) for the fallback.
function sentenceCase(value: string): string {
  const spaced = value.split('_').join(' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The display name of a post format. With a known platform it is exactly the
 * create sheet's label (single_image reads "Image" on X and Threads); otherwise
 * the platform-neutral label. Never throws.
 */
export function postFormatLabel(format: string, platform?: string | null): string {
  if (!isPostFormat(format)) return sentenceCase(format);
  if (platform != null && isPostPlatform(platform)) return packageFormatLabel(platform, format);
  return POST_FORMAT_LABELS[format];
}
