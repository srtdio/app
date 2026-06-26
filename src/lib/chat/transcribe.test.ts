import { describe, expect, it } from 'vitest';
import { transcribeAudio } from '@/lib/chat/transcribe';

// The fetcher is injected, so no network is touched: each test supplies a stub
// that records the request and returns a canned Response. The contract under
// test is that transcribeAudio never throws and returns a Result that is ok only
// for a 200 carrying { ok: true, transcript: string }.

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const blob = new Blob(['audio-bytes'], { type: 'audio/webm' });

describe('transcribeAudio', () => {
  it('returns the transcript and carries the Bearer token + blob body on a 200', async () => {
    let seenInput = '';
    let seenInit: RequestInit | null = null;
    const result = await transcribeAudio({
      blob,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok-123',
      fetcher: async (input, init) => {
        seenInput = input;
        seenInit = init;
        return jsonResponse({ ok: true, transcript: 'hi' });
      },
    });
    expect(result).toEqual({ ok: true, transcript: 'hi' });
    expect(seenInput).toBe('https://transcribe.example.dev');
    const init = seenInit as unknown as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['content-type']).toBe('audio/webm');
    expect(init.body).toBe(blob);
    expect(init.method).toBe('POST');
  });

  it('returns ok:false on a non-ok response', async () => {
    const result = await transcribeAudio({
      blob,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () => jsonResponse({ ok: true, transcript: 'x' }, false),
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false (never throws) when the fetcher throws', async () => {
    const result = await transcribeAudio({
      blob,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () => {
        throw new Error('network down');
      },
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on malformed JSON / missing transcript', async () => {
    const missing = await transcribeAudio({
      blob,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () => jsonResponse({ ok: true }),
    });
    expect(missing.ok).toBe(false);

    const malformed = await transcribeAudio({
      blob,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response,
    });
    expect(malformed.ok).toBe(false);
  });
});
