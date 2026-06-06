// Auth-suite environment handoff and JWT helpers. The connection details are a
// superset of the RLS suite's RlsEnv (so seedUser/clientFor can be reused) plus
// the JWT secret, which the suite needs to forge a validly-signed but expired
// access token for the rejection test.

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RlsEnv } from '../../packages/test-utils/rls';

export interface AuthTestEnv extends RlsEnv {
  jwtSecret: string;
}

/** Path of the JSON handoff written by the global setup process. */
export const authEnvFile = join(tmpdir(), 'sorted-auth-env.json');

/** Read the connection env produced by tests/auth/setup.ts. */
export function loadAuthTestEnv(): AuthTestEnv {
  const raw = JSON.parse(readFileSync(authEnvFile, 'utf8')) as Partial<AuthTestEnv>;
  const { url, anonKey, serviceKey, dbUrl, jwtSecret } = raw;
  if (!url || !anonKey || !serviceKey || !dbUrl || !jwtSecret) {
    throw new Error('auth env handoff is incomplete; was tests/auth/setup.ts run?');
  }
  return { url, anonKey, serviceKey, dbUrl, jwtSecret };
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint an HS256 access token for `userId` that is already expired but correctly
 * signed with the project's JWT secret. GoTrue must reject it for being expired
 * (not for a bad signature), which is exactly what the rejection test asserts.
 */
export async function signExpiredAccessToken(env: AuthTestEnv, userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    iss: `${env.url}/auth/v1`,
    iat: now - 7200,
    exp: now - 3600,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    is_anonymous: false,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
