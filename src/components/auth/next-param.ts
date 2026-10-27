// ?next= helpers: the open-redirect guard and the sign-in destination. Kept
// apart from SignInPage so RouteGuards (on every app boot) imports no page and
// the sign-in, sign-up and auth-shell chunks stay out of the boot set. This
// module imports nothing.

/**
 * Open-redirect guard for ?next=. Only an in-app path is allowed: it must start
 * with a single '/', never '//' (protocol-relative), never a backslash (browsers
 * read a leading slash plus backslash as '//') and never a control or whitespace
 * character (browsers strip tabs and newlines, so a slash, tab, slash prefix
 * would become '//').
 * Anything else, absolute URLs included, returns '' (no destination).
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return '';
  return raw;
}

/** A path with a safe destination appended as ?next=; the path alone when there is none. */
export function withNext(path: string, next: string): string {
  const safe = safeNextPath(next);
  return safe === '' ? path : `${path}?next=${encodeURIComponent(safe)}`;
}

/** RequireAuth hands the blocked location over as router state { from }. */
function stateFrom(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('from' in state)) return '';
  const from = (state as { from: unknown }).from;
  return typeof from === 'string' ? from : '';
}

/** The sign-in destination: a safe ?next= first, then RequireAuth's { from } state. */
export function resolveNext(queryNext: string | null, state: unknown): string {
  return safeNextPath(queryNext) || safeNextPath(stateFrom(state));
}
