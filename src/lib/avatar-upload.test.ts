import { describe, expect, it, vi } from 'vitest';
import {
  avatarCleanupUrl,
  cleanupOldAvatar,
  fireAvatarCleanup,
  makeAvatarCleanup,
  replacedAvatarUrl,
  uploadAvatarFile,
} from '@/lib/avatar-upload';

const ENDPOINT = 'https://avatar.example.test/upload';

function pngFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('uploadAvatarFile', () => {
  it('returns ok with the avatarUrl and POSTs the file with a Bearer header', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { avatar_url: 'https://cdn.test/a.png' }));

    const result = await uploadAvatarFile(pngFile(), {
      endpoint: ENDPOINT,
      token: 'tok-123',
      fetcher,
    });

    expect(result).toEqual({ ok: true, data: { avatarUrl: 'https://cdn.test/a.png' } });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    if (call === undefined) throw new Error('fetcher was not called');
    const [url, init] = call;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    // No content-type header: the browser sets the multipart boundary itself.
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    const sent = (init.body as FormData).get('file');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('avatar.png');
  });

  it('returns an error result on a non-ok status', async () => {
    const fetcher = vi.fn(async () => jsonResponse(500, { error: 'boom' }));

    const result = await uploadAvatarFile(pngFile(), {
      endpoint: ENDPOINT,
      token: 'tok',
      fetcher,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message.length).toBeGreaterThan(0);
  });

  it('returns an error result when avatar_url is missing', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { not_a_url: true }));

    const result = await uploadAvatarFile(pngFile(), {
      endpoint: ENDPOINT,
      token: 'tok',
      fetcher,
    });

    expect(result.ok).toBe(false);
  });
});

const OLD_URL = 'https://cdn.srtd.io/u-1/old.png';

describe('avatarCleanupUrl', () => {
  it('resolves the cleanup route under the upload endpoint', () => {
    expect(avatarCleanupUrl('https://w.dev')).toBe('https://w.dev/avatar/cleanup');
    expect(avatarCleanupUrl('https://w.dev/')).toBe('https://w.dev/avatar/cleanup');
    expect(avatarCleanupUrl('https://w.dev/base?x=1')).toBe('https://w.dev/base/avatar/cleanup');
    expect(avatarCleanupUrl('not a url')).toBeNull();
  });
});

describe('cleanupOldAvatar', () => {
  it('POSTs { old_url } as JSON with the Bearer token and apikey', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { deleted: true }));
    await cleanupOldAvatar(OLD_URL, {
      endpoint: 'https://w.dev',
      token: 'tok',
      apiKey: 'sb_publishable_x',
      fetcher,
    });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    if (call === undefined) throw new Error('fetcher was not called');
    const [url, init] = call;
    expect(url).toBe('https://w.dev/avatar/cleanup');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.apikey).toBe('sb_publishable_x');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ old_url: OLD_URL });
  });

  it('never throws, and sends nothing without a token or a URL', async () => {
    const throwing = vi.fn(async (): Promise<Response> => {
      throw new Error('down');
    });
    await expect(
      cleanupOldAvatar(OLD_URL, { endpoint: 'https://w.dev', token: 't', fetcher: throwing }),
    ).resolves.toBeUndefined();
    const fetcher = vi.fn(async () => jsonResponse(500, {}));
    await cleanupOldAvatar(OLD_URL, { endpoint: 'https://w.dev', token: null, fetcher });
    await cleanupOldAvatar('', { endpoint: 'https://w.dev', token: 't', fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('replacedAvatarUrl / fireAvatarCleanup', () => {
  it('names the previous URL only when it was set and differs', () => {
    expect(replacedAvatarUrl(OLD_URL, 'https://cdn.srtd.io/u-1/new.png')).toBe(OLD_URL);
    expect(replacedAvatarUrl(OLD_URL, '')).toBe(OLD_URL);
    expect(replacedAvatarUrl(OLD_URL, OLD_URL)).toBeNull();
    expect(replacedAvatarUrl(null, 'x')).toBeNull();
    expect(replacedAvatarUrl('', 'x')).toBeNull();
    expect(replacedAvatarUrl(undefined, 'x')).toBeNull();
  });

  it('starts the cleanup without waiting and swallows its failures', () => {
    const cleanup = vi.fn(() => Promise.reject(new Error('down')));
    expect(fireAvatarCleanup(cleanup, OLD_URL, '')).toBeUndefined();
    expect(cleanup).toHaveBeenCalledWith(OLD_URL);
    const throwing = vi.fn((): Promise<void> => {
      throw new Error('sync');
    });
    expect(() => fireAvatarCleanup(throwing, OLD_URL, '')).not.toThrow();
  });
});

describe('makeAvatarCleanup', () => {
  it('does nothing without an endpoint and sends one call with a fresh token', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { deleted: true }));
    const getToken = vi.fn(async () => 'tok');
    await makeAvatarCleanup({ endpoint: undefined, getToken, apiKey: 'k', fetcher })(OLD_URL);
    expect(getToken).not.toHaveBeenCalled();
    await makeAvatarCleanup({ endpoint: 'https://w.dev', getToken, apiKey: 'k', fetcher })(OLD_URL);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const failingToken = vi.fn(async (): Promise<string | null> => {
      throw new Error('no session');
    });
    await expect(
      makeAvatarCleanup({
        endpoint: 'https://w.dev',
        getToken: failingToken,
        apiKey: 'k',
        fetcher,
      })(OLD_URL),
    ).resolves.toBeUndefined();
  });
});
