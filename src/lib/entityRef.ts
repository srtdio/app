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
 * Format a key and number as a display reference: "KEY-N", uppercase, no leading
 * zeros on the number.
 */
export function formatEntityRef(key: string, number: number): string {
  return `${key.toUpperCase()}-${number}`;
}

/**
 * Build the canonical in-app path for a post or brief reference: "/p/key-n" for a
 * post, "/b/key-n" for a brief, with the key lowercased and no leading zeros.
 */
export function entityUrlPath(kind: 'post' | 'brief', key: string, number: number): string {
  const prefix = kind === 'post' ? '/p' : '/b';
  return `${prefix}/${key.toLowerCase()}-${number}`;
}
