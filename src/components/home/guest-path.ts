// Guest-path decision for src/main.tsx. Runs synchronously before anything
// heavy is imported, so this module must import nothing. The inline script in
// index.html mirrors isGuestHome and isHomeBundlePath to paint the light
// canvas; keep them in sync.

/** Supabase's default localStorage key: sb-<project-ref>-auth-token. */
const AUTH_TOKEN_KEY = /^sb-.+-auth-token$/;

// Auth callbacks (PKCE code, implicit tokens, errors, email-link type) must
// always reach the app so Supabase can finish the sign-in.
const AUTH_CALLBACK = /(?:^|[?&#])(?:code|type)=|access_token|refresh_token|error_description/;

export interface GuestPathInput {
  pathname: string;
  search: string;
  hash: string;
  /** May throw (storage blocked); a throw counts as "no session". */
  storageKeys: () => string[];
}

/**
 * Whether supabase-js has a stored auth session key on this device. Only the
 * key's existence is checked (never its value): it decides what boots, not
 * what is shown.
 */
export function hasStoredSession(storageKeys: () => string[]): boolean {
  try {
    return storageKeys().some((key) => AUTH_TOKEN_KEY.test(key));
  } catch {
    return false;
  }
}

/** True when "/" can render the homepage without loading the app. */
export function isGuestHome(input: GuestPathInput): boolean {
  if (input.pathname !== '/') return false;
  if (AUTH_CALLBACK.test(input.search) || AUTH_CALLBACK.test(input.hash)) return false;
  return !hasStoredSession(input.storageKeys);
}

/** Pages the home bundle serves to everyone, signed in or not (no redirect). */
const HOME_BUNDLE_PATHS: readonly string[] = ['/demo'];

/** True for /demo: the home bundle renders it for guests and members. */
export function isHomeBundlePath(pathname: string): boolean {
  return HOME_BUNDLE_PATHS.includes(pathname);
}

export function localStorageKeys(): string[] {
  const storage = window.localStorage;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}
