// Plain words for a failed save in the create sheet: "Couldn't {action}.
// {reason}" through the shared helper, with invalid_format naming the platform.
// Raw server text is never shown.

import { platformLabel, type PostPlatform } from '@srtdio/posts';
import { errorText } from '@/lib/error-copy';

/** The line for any failure the sheet does not know. */
export const POST_SAVE_FAILED = errorText('save the post', null);

/** The line for a new bucket that did not save. */
export const BUCKET_SAVE_FAILED = errorText('create the bucket', null);

/** The sheet's copy for a failure code or message. Pure. */
export function createSheetErrorMessage(
  message: string,
  platform: PostPlatform | null,
  action = 'save the post',
): string {
  if (message === 'invalid_format') {
    return platform !== null
      ? `That format is not available on ${platformLabel(platform)}.`
      : 'That format is not available here.';
  }
  return errorText(action, message);
}
