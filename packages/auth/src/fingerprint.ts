// Device-fingerprint header contract shared by the session-register edge
// function and the fingerprint middleware. The fingerprint is a SHA-256 of a
// stable client signal, sent as 64 lowercase hex chars in X-Device-Fingerprint.

/** The header the client sends its device fingerprint in. */
export const FINGERPRINT_HEADER = 'X-Device-Fingerprint';

/**
 * A SHA-256 hex digest: exactly 64 lowercase hex characters. Mirrors the
 * session_devices_fingerprint_hash_check constraint in the baseline migration,
 * so a value that fails here would also be rejected by Postgres.
 */
export const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/** Narrowing guard: true when `value` is a syntactically valid fingerprint. */
export function isValidFingerprint(value: string | null | undefined): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}
