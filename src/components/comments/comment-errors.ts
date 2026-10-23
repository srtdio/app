// Plain copy for a failed comment read or write. The raw error message is never
// shown: it is a Postgres code or a transport string, not something a person can
// act on. The words come from the shared "Couldn't {action}. {reason}" helper.

import { errorText } from '@/lib/error-copy';

/** Map a comment error (by code, then by the raised message) to plain copy. */
export function friendlyCommentError(
  error: { code: string; message: string },
  action = 'post the comment',
): string {
  return errorText(action, error);
}
