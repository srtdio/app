// Frontend port of the Agora Chat identity derivation in
// src/server/workers/agora-identity.ts. Agora rejects UUID-shaped usernames, so
// a Supabase user id is mapped to a canonical, reversible, non-UUID Agora
// username and back. The chat shell needs this on the read path (map an
// incoming message's Agora username to a Sorted user id) and the write path
// (map the current user / a DM peer to an Agora username).
//
// This is a byte-for-byte copy of the worker's pure functions: the worker lives
// under src/server (a different build target) and cannot be imported here
// without editing root package.json / tsconfig.base.json, which are off-limits
// for this PR. The round-trip parity test in agora-identity.test.ts asserts the
// two stay in lockstep against the documented scheme.
//
// TODO(2026-06-13): extract toAgoraUsername / fromAgoraUsername into a shared
// package consumed by both the worker and the frontend so this copy can be
// deleted.

/** Canonical UUID shape (any version), case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prefix that makes the username non-UUID-shaped and namespaces it. */
const AGORA_USERNAME_PREFIX = 'u_';

/** A `u_` followed by exactly 32 lowercase hex digits (no hyphens). */
const AGORA_USERNAME_RE = /^u_[0-9a-f]{32}$/;

/**
 * Derive the canonical Agora Chat username for a Supabase user id. Validates the
 * id is a canonical UUID (crash early on anything else), then returns
 * `"u_" + uuid.toLowerCase()` with every hyphen removed. The `u_` prefix and the
 * stripped hyphens guarantee the result is never itself UUID-shaped, so Agora
 * accepts it. Result is 34 chars and within Agora's charset [a-z0-9_.-].
 */
export function toAgoraUsername(userId: string): string {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error(`Invalid Supabase user id for Agora username: ${String(userId)}`);
  }
  return AGORA_USERNAME_PREFIX + userId.toLowerCase().replace(/-/g, '');
}

/**
 * Reconstruct the original Supabase user id from a username produced by
 * {@link toAgoraUsername}. Strips the `u_` prefix and re-inserts hyphens at the
 * canonical 8-4-4-4-12 positions. Throws when the shape is not `u_` + 32 hex.
 */
export function fromAgoraUsername(username: string): string {
  if (typeof username !== 'string' || !AGORA_USERNAME_RE.test(username)) {
    throw new Error(`Malformed Agora username: ${String(username)}`);
  }
  const hex = username.slice(AGORA_USERNAME_PREFIX.length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Total order on Agora usernames is not required, but a guarded variant is:
 * map an incoming username to a user id, returning empty over a throw so a
 * malformed sender never crashes the live thread.
 */
export function userIdFromAgoraUsername(
  username: string,
): { ok: true; userId: string } | { ok: false } {
  if (typeof username !== 'string' || !AGORA_USERNAME_RE.test(username)) {
    return { ok: false };
  }
  return { ok: true, userId: fromAgoraUsername(username) };
}
