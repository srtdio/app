// @srtdio/auth: the device-fingerprint session gate shared by the
// session-register edge function and every authed worker. No framework imports;
// pure functions over a Supabase client plus a tiny middleware abstraction.

export { compose } from './compose.ts';
export { BadRequestError, HttpError, UnauthorizedError } from './errors.ts';
export { FINGERPRINT_HEADER, FINGERPRINT_PATTERN, isValidFingerprint } from './fingerprint.ts';
export { IPV4_PREFIX, IPV6_PREFIX, ipSubnet } from './ip.ts';
export { fingerprintMiddleware, type AuthContext, type Middleware } from './middleware.ts';
export {
  registerSession,
  STALE_SESSION_MS,
  type RegisterSessionInput,
  type RegisterSessionResult,
} from './register.ts';
