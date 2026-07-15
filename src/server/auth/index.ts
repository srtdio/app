// Public surface of the auth server. All flows return a Result; none throw for
// an expected failure.

export { loginWithPassword } from './login';
export { confirmPasswordReset, requestPasswordReset } from './password-reset';
export { refreshSession, signOut, verifyAccessToken } from './session';
export { signupWithMagicLink, verifyMagicLink } from './signup';
