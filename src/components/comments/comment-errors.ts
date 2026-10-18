// Plain copy for a failed comment read or write. The raw error message is never
// shown: it is a Postgres code or a transport string, not something a person can
// act on.

export const PERMISSION_COPY = "You don't have permission to do that.";
export const NOT_FOUND_COPY = 'This comment no longer exists.';
export const GENERIC_COPY = 'Something went wrong. Try again.';

/** Map a comment error (by code, then by the raised message) to plain copy. */
export function friendlyCommentError(error: { code: string; message: string }): string {
  if (error.code === 'forbidden_role' || error.code === 'workspace_member_only') {
    return PERMISSION_COPY;
  }
  if (/not[_ ]found/i.test(error.message) || error.code === 'not_found') return NOT_FOUND_COPY;
  return GENERIC_COPY;
}
