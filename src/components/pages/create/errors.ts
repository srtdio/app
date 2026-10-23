// Plain words for a failed save in the create sheet. Known codes get their own
// line; anything else is the generic one. Raw server text is never shown.

import { platformLabel, type PostPlatform } from '@srtdio/posts';
import { GENERIC_ERROR, plainError } from '@/lib/error-copy';

/** The line for any failure the sheet does not know. */
export const POST_SAVE_FAILED = "Couldn't save the post. Try again.";

/** The line for a new bucket that did not save. */
export const BUCKET_SAVE_FAILED = "Couldn't create the bucket. Try again.";

/** The sheet's copy for a failure code or message. Pure. */
export function createSheetErrorMessage(
  message: string,
  platform: PostPlatform | null,
  fallback: string = POST_SAVE_FAILED,
): string {
  if (message === 'invalid_format') {
    return platform !== null
      ? `That format is not available on ${platformLabel(platform)}.`
      : 'That format is not available here.';
  }
  const plain = plainError(message);
  return plain === GENERIC_ERROR ? fallback : plain;
}
