// Catch-up email unsubscribe token (implements UnsubscribeTokenApi).
//
// token = base64url (no padding) of HMAC-SHA256(key = secret, message = userId),
// via Web Crypto (globalThis.crypto.subtle: Cloudflare Workers and Node 22).
// No expiry. Verify recomputes and compares in constant time. The edge function
// supabase/functions/catchup-unsubscribe keeps its own copy of this verify (it
// cannot import packages/); both suites assert UNSUBSCRIBE_TEST_VECTOR.

import { UNSUBSCRIBE_FUNCTION_NAME } from './catchup-contracts';
import type { UnsubscribeTokenApi } from './catchup-contracts';

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

/** Constant-time string compare: walks the full length, never exits early. */
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

function tokenQuery(userId: string, token: string): string {
  return new URLSearchParams({ u: userId, t: token }).toString();
}

export const signUnsubscribeToken: UnsubscribeTokenApi['signUnsubscribeToken'] = async (
  userId,
  secret,
) => toBase64Url(await hmacSha256(secret, userId));

export const verifyUnsubscribeToken: UnsubscribeTokenApi['verifyUnsubscribeToken'] = async (
  userId,
  token,
  secret,
) => {
  try {
    if (typeof userId !== 'string' || typeof token !== 'string' || typeof secret !== 'string') {
      return false;
    }
    if (userId.length === 0 || token.length === 0 || secret.length === 0) return false;
    const expected = await signUnsubscribeToken(userId, secret);
    return timingSafeEqual(expected, token);
  } catch {
    return false;
  }
};

export const buildUnsubscribePageUrl: UnsubscribeTokenApi['buildUnsubscribePageUrl'] = (
  appBaseUrl,
  userId,
  token,
) => `${stripTrailingSlash(appBaseUrl)}/unsubscribe?${tokenQuery(userId, token)}`;

export const buildOneClickUrl: UnsubscribeTokenApi['buildOneClickUrl'] = (
  supabaseUrl,
  userId,
  token,
) =>
  `${stripTrailingSlash(supabaseUrl)}/functions/v1/${UNSUBSCRIBE_FUNCTION_NAME}?${tokenQuery(userId, token)}`;
