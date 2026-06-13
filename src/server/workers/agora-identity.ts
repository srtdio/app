// Agora Chat identity derivation.
//
// Agora rejects UUID-shaped usernames ("username [uuid] is not legal", 400
// illegal_argument), so the Supabase user id cannot be passed verbatim. This
// module derives a canonical, reversible, non-UUID Agora username from a
// Supabase user id and back again, so the registration body, the minted user
// token, and the returned agora_username all agree on one deterministic value.
//
// Pure and I/O-free: deterministic and round-trippable
// (fromAgoraUsername(toAgoraUsername(id)) === id).

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
