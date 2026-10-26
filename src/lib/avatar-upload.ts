// Client upload module for the onboarding avatar. Mirrors src/lib/asset-upload.ts
// (uploadAssetFile): build multipart FormData, POST to the avatar-upload Worker
// with a Bearer token and NO content-type header (the browser sets the multipart
// boundary), and adapt the worker's { avatar_url } response into the shared
// Result shape. The network call takes an injected fetcher so tests drive it with
// a mock and the app passes fetchWithTrace; there is no native fetch in this file.

import type { Result } from '@srtdio/rpc';

interface AvatarUploadConfig {
  /** The avatar-upload Worker URL (env.VITE_AVATAR_UPLOAD_URL). */
  endpoint: string;
  /** Fresh Bearer token; null when no session, which the worker rejects. */
  token: string | null;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * A group photo instead of the caller's own avatar. The worker authorises it
   * (creator or workspace owner/admin) as the caller, so it also needs the public
   * Supabase key (`apiKey`) to read PostgREST with the caller's token. Absent
   * means the user avatar path, unchanged.
   */
  target?: { kind: 'group'; id: string; apiKey: string };
}

/** Collapse a transport / unexpected failure to the shared Result error shape. */
function fail(message: string): Result<never> {
  return { ok: false, error: { code: 'unknown', message } };
}

/**
 * POST the cropped PNG as multipart {file} with a Bearer token. Never throws: a
 * transport failure or a non-OK status becomes { ok: false } with a readable
 * message. On success the worker returns { avatar_url }; a missing or non-string
 * avatar_url is treated as a failure.
 */
export async function uploadAvatarFile(
  file: File,
  config: AvatarUploadConfig,
): Promise<Result<{ avatarUrl: string }>> {
  const form = new FormData();
  form.append('file', file, 'avatar.png');
  const headers: Record<string, string> = { Authorization: `Bearer ${config.token}` };
  if (config.target !== undefined) {
    form.append('target_kind', config.target.kind);
    form.append('target_id', config.target.id);
    headers.apikey = config.target.apiKey;
  }

  let response: Response;
  try {
    response = await config.fetcher(config.endpoint, {
      method: 'POST',
      headers,
      body: form,
    });
  } catch {
    return fail("Couldn't upload. Try again.");
  }

  if (!response.ok) {
    return fail("Couldn't upload. Try again.");
  }

  const body = await readJson(response);
  const avatarUrl = avatarUrlOf(body);
  if (avatarUrl === null) {
    return fail("Couldn't upload. Try again.");
  }
  return { ok: true, data: { avatarUrl } };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Read avatar_url from a { avatar_url } body; null when absent or not a string. */
function avatarUrlOf(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const url = (body as { avatar_url?: unknown }).avatar_url;
    if (typeof url === 'string' && url !== '') return url;
  }
  return null;
}

interface AvatarCleanupConfig {
  /** The avatar-upload Worker URL (env.VITE_AVATAR_UPLOAD_URL). */
  endpoint: string;
  /** Fresh Bearer token; null when no session, in which case nothing is sent. */
  token: string | null;
  /** Injected so tests pass a mock; the app passes fetchWithTrace with a fresh trace. */
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Public Supabase key. The worker reads the caller's profile as the caller,
   * which PostgREST only accepts with an apikey; sending it here keeps cleanup
   * working even when the worker's own copy is not configured.
   */
  apiKey?: string;
}

/**
 * The cleanup route on the avatar-upload Worker, resolved against the upload
 * endpoint as a directory: `https://w.dev` and `https://w.dev/` both give
 * `https://w.dev/avatar/cleanup`. Null when the endpoint is not a valid URL.
 */
export function avatarCleanupUrl(endpoint: string): string | null {
  try {
    const base = new URL(endpoint);
    base.search = '';
    base.hash = '';
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    return new URL('avatar/cleanup', base).toString();
  } catch {
    return null;
  }
}

/**
 * Ask the worker to delete a replaced avatar object. Call only AFTER the
 * user_profile_update that replaced or cleared `oldUrl` succeeded; the worker
 * re-checks that the profile no longer references it before deleting. Best
 * effort: never throws, never reports anything, and returns once the request
 * settles (callers fire and forget).
 */
export async function cleanupOldAvatar(oldUrl: string, config: AvatarCleanupConfig): Promise<void> {
  if (oldUrl === '' || config.token === null) return;
  const url = avatarCleanupUrl(config.endpoint);
  if (url === null) return;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };
  if (config.apiKey !== undefined && config.apiKey !== '') headers.apikey = config.apiKey;
  try {
    await config.fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ old_url: oldUrl }),
    });
  } catch {
    // Best effort: a missed cleanup only leaves an unreferenced object behind.
  }
}

/**
 * The previously saved avatar a successful save left unreferenced, or null:
 * only a non-empty previous URL that differs from the new one ('' = cleared).
 * Pure.
 */
export function replacedAvatarUrl(
  previous: string | null | undefined,
  next: string | null,
): string | null {
  const before = previous ?? '';
  return before !== '' && before !== (next ?? '') ? before : null;
}

/**
 * Fire and forget: start `cleanup(old)` when the save replaced or cleared a
 * previous avatar. Never awaits, never throws, never surfaces anything.
 */
export function fireAvatarCleanup(
  cleanup: (oldUrl: string) => Promise<void>,
  previous: string | null | undefined,
  next: string | null,
): void {
  const old = replacedAvatarUrl(previous, next);
  if (old === null) return;
  try {
    void cleanup(old).catch(() => undefined);
  } catch {
    // Best effort only.
  }
}

/**
 * The app's cleanup call: resolves the endpoint and a fresh token at call time.
 * Without an endpoint it does nothing. Never throws.
 */
export function makeAvatarCleanup(deps: {
  endpoint: string | undefined;
  getToken: () => Promise<string | null>;
  apiKey: string;
  fetcher: AvatarCleanupConfig['fetcher'];
}): (oldUrl: string) => Promise<void> {
  return async (oldUrl) => {
    if (deps.endpoint === undefined) return;
    let token: string | null;
    try {
      token = await deps.getToken();
    } catch {
      return;
    }
    await cleanupOldAvatar(oldUrl, {
      endpoint: deps.endpoint,
      token,
      fetcher: deps.fetcher,
      apiKey: deps.apiKey,
    });
  };
}
