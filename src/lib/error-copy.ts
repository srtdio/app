// One plain sentence for a failure, never the raw PostgREST or exception text.
// Known domain codes (the procs' RAISE names, src/packages/rpc) and the
// transport failures a phone meets (offline, a timeout) each get their own
// line; anything else is the generic one. Pages adopt it in their own PRs.

export const GENERIC_ERROR = 'Something went wrong. Try again.';

const KNOWN: Record<string, string> = {
  forbidden_role: "You don't have permission to do that.",
  invalid_payload: "Something in that request wasn't right. Check it and try again.",
  not_authenticated: 'Your session has ended. Sign in again.',
  network_failure: "You're offline or the connection dropped. Check your network and try again.",
  timeout: 'That took too long. Try again.',
};

/** Normalise a code or message to one of KNOWN's keys, or null. */
function codeOf(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  if (t === 'forbidden_role') return 'forbidden_role';
  if (t === 'invalid_payload') return 'invalid_payload';
  if (t === 'not authenticated' || t === 'not_authenticated' || t === 'unauthenticated')
    return 'not_authenticated';
  if (
    t === 'network_failure' ||
    t === 'network failure' ||
    t === 'failed to fetch' ||
    t === 'load failed' ||
    t === 'networkerror when attempting to fetch resource.' ||
    t === 'networkerror' ||
    t === 'network request failed'
  )
    return 'network_failure';
  if (
    t === 'timeout' ||
    t === 'timed out' ||
    t === 'aborterror' ||
    t === 'timeouterror' ||
    t === 'statement_timeout' ||
    t === '57014' ||
    t === 'canceling statement due to statement timeout'
  )
    return 'timeout';
  return null;
}

/** The strings an unknown error value may carry a code or message in. */
function candidates(error: unknown): string[] {
  if (typeof error === 'string') return [error];
  if (error instanceof Error) return [error.name, error.message];
  if (typeof error === 'object' && error !== null) {
    const out: string[] = [];
    for (const key of ['code', 'name', 'message', 'error', 'reason']) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string') out.push(value);
    }
    return out;
  }
  return [];
}

/**
 * A plain sentence for `error`: a domain code string, an Error, a PostgREST
 * or DomainError object ({ code, message }), or anything else. The known
 * codes map to their own line; everything else to the generic one. The input
 * text itself is never returned.
 */
export function plainError(error: unknown): string {
  for (const text of candidates(error)) {
    const code = codeOf(text);
    if (code !== null) return KNOWN[code] ?? GENERIC_ERROR;
  }
  return GENERIC_ERROR;
}
