// Pretty entity references: a workspace key plus a per-workspace entity number
// (e.g. GBL-142) that identifies a post or brief in a human-readable, shareable
// form. The canonical URL forms are /p/<key>-<number> for posts and
// /b/<key>-<number> for briefs; both keys are lowercased in the address bar and
// uppercased for display. This module is pure string logic with no I/O.

/** A parsed reference: an uppercase workspace key and a positive entity number. */
export interface EntityRef {
  key: string;
  number: number;
}

// A reference is <key>-<number>: the key is 2-5 chars, starts with a letter,
// then letters/digits; the number is 1-9 digits. Matched case-insensitively on
// a trimmed, lowercased string, so GBL-142, gbl-142 and " Gbl-0142 " all parse.
const REF_PATTERN = /^([a-z][a-z0-9]{1,4})-([0-9]{1,9})$/;

/**
 * Parse a raw reference string into its key and number, or null when it does not
 * match the canonical form. The input is trimmed and lowercased first; the key is
 * returned UPPERCASE and the number is parsed base 10 (so leading zeros are
 * normalized away). A number below 1 is rejected as null.
 */
export function parseEntityRef(raw: string): EntityRef | null {
  const match = REF_PATTERN.exec(raw.trim().toLowerCase());
  if (match === null) return null;
  const key = match[1];
  const digits = match[2];
  if (key === undefined || digits === undefined) return null;
  const number = parseInt(digits, 10);
  if (number < 1) return null;
  return { key: key.toUpperCase(), number };
}

/**
 * Build the canonical in-app path for a post or brief reference: "/p/key-n" for a
 * post, "/b/key-n" for a brief, with the key lowercased and no leading zeros.
 */
export function entityUrlPath(kind: 'post' | 'brief', key: string, number: number): string {
  const prefix = kind === 'post' ? '/p' : '/b';
  return `${prefix}/${key.toLowerCase()}-${number}`;
}

/**
 * Router state an in-app open attaches to a pretty link when it already holds
 * the entity's id (a post card knows post.id), so the /p and /b resolvers skip
 * their lookups. It names the ref it belongs to: a state carried to any other
 * address is ignored. Only this app writes router state, and the page that
 * renders still reads the entity under RLS, so a wrong id can never show what
 * the viewer may not see.
 */
export interface RefOpenState {
  entityRef: { kind: 'post' | 'brief'; key: string; number: number; id: string };
}

/** The router state for opening `id` at its pretty link. */
export function refOpenState(
  kind: 'post' | 'brief',
  key: string,
  number: number,
  id: string,
): RefOpenState {
  return { entityRef: { kind, key: key.toUpperCase(), number, id } };
}

/**
 * The id a {@link refOpenState} carries when it was made for exactly this kind
 * and raw ref, else null (no state, another ref, a malformed value).
 */
export function knownRefId(
  state: unknown,
  kind: 'post' | 'brief',
  rawRef: string | undefined,
): string | null {
  if (rawRef === undefined || state === null || typeof state !== 'object') return null;
  const carried = (state as { entityRef?: unknown }).entityRef;
  if (carried === null || typeof carried !== 'object') return null;
  const { kind: k, key, number, id } = carried as Record<string, unknown>;
  if (k !== kind || typeof key !== 'string' || typeof number !== 'number') return null;
  if (typeof id !== 'string' || id === '') return null;
  const parsed = parseEntityRef(rawRef);
  if (parsed === null || parsed.key !== key.toUpperCase() || parsed.number !== number) return null;
  return id;
}
