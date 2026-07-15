// Public surface of the auth server. All flows return a Result; none throw for
// an expected failure.

export type { AuthEnv } from './config';
export {
  ACCESS_TOKEN_TTL_SECONDS,
  createAnonAuthClient,
  createServiceAuthClient,
  loadAuthEnv,
} from './config';
export { loginWithPassword } from './login';
export { confirmPasswordReset, requestPasswordReset } from './password-reset';
export { refreshSession, signOut, verifyAccessToken } from './session';
export { signupWithMagicLink, verifyMagicLink } from './signup';
