// Public surface of the auth server. All flows return a Result; none throw for
// an expected failure.

export type { AuthEnv } from './config';
export {
  ACCESS_TOKEN_TTL_SECONDS,
  createAnonAuthClient,
  createServiceAuthClient,
  loadAuthEnv,
} from './config';
export { mapAuthError } from './errors';
export { loginWithPassword, type LoginInput } from './login';
export {
  confirmPasswordReset,
  PASSWORD_MIN,
  requestPasswordReset,
  type ResetConfirmInput,
  type ResetRequestInput,
} from './password-reset';
export {
  refreshSession,
  signOut,
  toAuthSession,
  verifyAccessToken,
  type RefreshInput,
  type SignOutInput,
} from './session';
export {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  signupWithMagicLink,
  verifyMagicLink,
  type SignupInput,
  type VerifyMagicLinkInput,
} from './signup';
export type { AuthSession, DomainError, DomainErrorCode, Result } from './types';
