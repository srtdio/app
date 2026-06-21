// Client upload module for the onboarding avatar. Mirrors src/lib/asset-upload.ts
// (uploadAssetFile): build multipart FormData, POST to the avatar-upload Worker
// with a Bearer token and NO content-type header (the browser sets the multipart
// boundary), and adapt the worker's { avatar_url } response into the shared
// Result shape. The network call takes an injected fetcher so tests drive it with
// a mock and the app passes fetchWithTrace; there is no native fetch in this file.

import type { Result } from '@srtdio/rpc';

export interface AvatarUploadConfig {
  /** The avatar-upload Worker URL (env.VITE_AVATAR_UPLOAD_URL). */
  endpoint: string;
  /** Fresh Bearer token; null when no session, which the worker rejects. */
  token: string | null;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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

  let response: Response;
  try {
    response = await config.fetcher(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
    });
  } catch {
    return fail('Upload failed. Check your connection and retry');
  }

  if (!response.ok) {
    return fail('Upload failed. Check your connection and retry');
  }

  const body = await readJson(response);
  const avatarUrl = avatarUrlOf(body);
  if (avatarUrl === null) {
    return fail('Upload failed. Check your connection and retry');
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
