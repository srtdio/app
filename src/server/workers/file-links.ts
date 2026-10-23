// File link keys for the srtd.io/f/* read route.
//
// A link key says "this user asked for file links today". It is minted by the
// asset-read Worker for a verified caller (POST /link-key) and carried on every
// file URL as ?k=. The key identifies the user only; it grants nothing by
// itself. Every /f request still runs the full membership / chat gate live, so
// a removed member is refused at once even with a valid key.
//
// Keys repeat for a whole UTC day (window start at 00:00 UTC) so a file's URL is
// identical all day and the browser's HTTP cache can reuse what it downloaded.
// A key stays valid until the end of the NEXT UTC day, so a key minted at 23:59
// does not expire a minute later.
//
// Format: `${userId}.${expiresAtSeconds}.${base64url(HMAC-SHA256)}`. The HMAC
// key is derived with HKDF-SHA256 from the Worker's existing service-role
// secret (info "sorted-file-links-v1"), so no new secret is needed. Pure Web
// Crypto: no network, no I/O at module eval.

const DAY_SECONDS = 24 * 60 * 60;
const HKDF_INFO = 'sorted-file-links-v1';
const HKDF_SALT = 'sorted-file-links';

const enc = new TextEncoder();

/** A minted link key and the instant it stops being accepted. */
export interface LinkKey {
  key: string;
  expiresAt: string;
}

/** The start of the UTC day holding `nowMs`, in whole seconds. Pure. */
export function linkWindowStartSeconds(nowMs: number): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  return nowSeconds - (nowSeconds % DAY_SECONDS);
}

/** Expiry for a key minted at `nowMs`: the end of the next UTC day. Pure. */
export function linkExpirySeconds(nowMs: number): number {
  return linkWindowStartSeconds(nowMs) + 2 * DAY_SECONDS;
}

/** Derive the HMAC key from the Worker secret (HKDF-SHA256). */
export async function deriveLinkSigningKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time byte comparison (length leak only). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mint the link key for a user as of `nowMs`. Identical for the whole UTC day. */
export async function issueLinkKey(input: {
  userId: string;
  nowMs: number;
  signingKey: CryptoKey;
}): Promise<LinkKey> {
  if (!UUID.test(input.userId)) {
    throw new Error('issueLinkKey: userId must be a uuid');
  }
  const exp = linkExpirySeconds(input.nowMs);
  const payload = `${input.userId}.${exp}`;
  const mac = await crypto.subtle.sign('HMAC', input.signingKey, enc.encode(payload));
  return {
    key: `${payload}.${toBase64Url(mac)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * The user id a link key was minted for, or null when the key is malformed,
 * tampered with, or expired. Pure (no network).
 */
export async function verifyLinkKey(input: {
  key: string;
  nowMs: number;
  signingKey: CryptoKey;
}): Promise<string | null> {
  const parts = input.key.split('.');
  if (parts.length !== 3) return null;
  const [userId, expRaw, macRaw] = parts as [string, string, string];
  if (!UUID.test(userId) || !/^\d{1,12}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  if (exp * 1000 <= input.nowMs) return null;
  const given = fromBase64Url(macRaw);
  if (given === null) return null;
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', input.signingKey, enc.encode(`${userId}.${expRaw}`)),
  );
  return timingSafeEqual(given, expected) ? userId : null;
}
