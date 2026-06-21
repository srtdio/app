import { describe, expect, it, vi } from 'vitest';
import { uploadAvatarFile } from '@/lib/avatar-upload';

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
