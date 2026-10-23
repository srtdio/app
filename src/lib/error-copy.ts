// The one failure line every surface shows: "Couldn't {action}. {reason}".
// The action is the caller's ("move the post", "post the reply"); the reason is
// read off the error by its code or raised message, never shown raw. Only the
// offline and unknown reasons are retryable: a refusal (no access, deleted,
// locked, conflict, a bad field) reads the same on a second try. Pure, apart
// from the navigator.onLine probe the offline check makes.

/** Why an action failed, as the copy groups it. */
export type ErrorReason =
  | 'offline'
  | 'forbidden'
  | 'not_found'
  | 'stale'
  | 'approved_locked'
  | 'caption_too_long'
  | 'title_required'
  | 'unknown';

/** The approved reason lines (23 Oct 2026), one per reason. */
export const REASON_COPY: Record<ErrorReason, string> = {
  offline: "You're offline.",
  forbidden: "You don't have access to do this.",
  not_found: 'It was deleted.',
  stale: 'Someone else changed it. Refresh to see the latest.',
  approved_locked: 'Approved posts are locked.',
  caption_too_long: 'Captions can be up to 4,000 characters.',
  title_required: 'Add a title to save.',
  unknown: 'Try again.',
};

const RETRYABLE: ReadonlySet<ErrorReason> = new Set<ErrorReason>(['offline', 'unknown']);

/** A failure in plain words, plus whether a Retry belongs beside it. */
export interface ErrorCopy {
  reason: ErrorReason;
  text: string;
  retryable: boolean;
}

// The code and message off any error shape the app produces: a DomainError
// ({ code, message }), a PostgREST error, a thrown Error, or a bare code string.
function partsOf(error: unknown): { code: string; message: string; isTypeError: boolean } {
  if (typeof error === 'string') return { code: error, message: error, isTypeError: false };
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    return {
      code: typeof code === 'string' ? code : '',
      message: typeof message === 'string' ? message : '',
      isTypeError: error instanceof TypeError,
    };
  }
  return { code: '', message: '', isTypeError: false };
}

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

const NETWORK_RE = /failed to fetch|networkerror|network request failed|load failed|network error/i;

/** Read the reason off an error. Server refusals win over the offline probe. */
export function errorReason(error: unknown): ErrorReason {
  const { code, message, isTypeError } = partsOf(error);
  const text = `${code} ${message}`;
  if (/post_approved_locked|approved_locked/i.test(text)) return 'approved_locked';
  if (/caption_too_long/i.test(text)) return 'caption_too_long';
  if (/title_required/i.test(text)) return 'title_required';
  if (/forbidden_role|workspace_member_only|permission denied|\b42501\b/i.test(text)) {
    return 'forbidden';
  }
  if (/not[_ ]found|\bPGRST116\b/i.test(text)) return 'not_found';
  if (/row_version|stale|version_conflict|\bconflict\b/i.test(text)) return 'stale';
  if (browserOffline() || isTypeError || NETWORK_RE.test(text)) return 'offline';
  return 'unknown';
}

/** "Couldn't {action}. {reason}" with the reason read off `error`. */
export function errorCopy(action: string, error: unknown): ErrorCopy {
  const reason = errorReason(error);
  return {
    reason,
    text: `Couldn't ${action}. ${REASON_COPY[reason]}`,
    retryable: RETRYABLE.has(reason),
  };
}

/** As {@link errorCopy}, the line only. */
export function errorText(action: string, error: unknown): string {
  return errorCopy(action, error).text;
}
