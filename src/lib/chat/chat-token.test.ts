import { describe, expect, it, vi } from 'vitest';
import { fetchChatToken, type ChatTokenRequest } from '@/lib/chat/chat-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const workerBody = {
  token: 'agora-token',
  expires_at: '2026-06-14T10:00:00.000Z',
  agora_username: 'u_abc',
  app_key: 'org#app',
};

const baseRequest = (fetcher: ChatTokenRequest['fetcher']): ChatTokenRequest => ({
  url: 'https://chat-token.example.workers.dev',
  accessToken: 'jwt',
  workspaceId: 'ws-1',
  fetcher,
});

describe('fetchChatToken', () => {
  it('POSTs { workspace_id } with a Bearer token and returns the worker fields verbatim', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, workerBody));

    const out = await fetchChatToken(baseRequest(fetcher));

    expect(out).toEqual({ ok: true, ...workerBody });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chat-token.example.workers.dev');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(JSON.parse(init.body as string)).toEqual({ workspace_id: 'ws-1' });
  });

  it('returns ok:false without calling fetch when the URL is missing', async () => {
    const fetcher = vi.fn();
    const out = await fetchChatToken({ ...baseRequest(fetcher), url: undefined });
    expect(out).toEqual({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns ok:false without calling fetch when the session is missing', async () => {
    const fetcher = vi.fn();
    const out = await fetchChatToken({ ...baseRequest(fetcher), accessToken: undefined });
    expect(out).toEqual({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns ok:false (not throw) on a non-2xx response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized' } }));
    const out = await fetchChatToken(baseRequest(fetcher));
    expect(out).toEqual({ ok: false });
  });

  it('returns ok:false (not throw) on a transport failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await fetchChatToken(baseRequest(fetcher));
    expect(out).toEqual({ ok: false });
  });

  it('returns ok:false when the body is missing a required field', async () => {
    const partial = {
      token: 'agora-token',
      expires_at: workerBody.expires_at,
      agora_username: 'u_abc',
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, partial));
    const out = await fetchChatToken(baseRequest(fetcher));
    expect(out).toEqual({ ok: false });
  });
});
