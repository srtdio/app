import { describe, expect, it, vi } from 'vitest';
import {
  isBadProbeStatus,
  isProbeableUrl,
  probeVoiceUrl,
  VOICE_PROBE_TIMEOUT_MS,
} from '@/lib/voice-probe';

const ORIGIN = 'https://srtd.io';

describe('isProbeableUrl', () => {
  it('accepts a same-origin file link, absolute or relative', () => {
    expect(isProbeableUrl('https://srtd.io/f/v1/full?k=a', ORIGIN)).toBe(true);
    expect(isProbeableUrl('/f/v1/full?k=a', ORIGIN)).toBe(true);
  });

  it('rejects cross-origin presigns, blob and data urls', () => {
    const presign = 'https://bucket.r2.cloudflarestorage.com/a?X-Amz=1';
    expect(isProbeableUrl(presign, ORIGIN)).toBe(false);
    expect(isProbeableUrl('blob:https://srtd.io/123', ORIGIN)).toBe(false);
    expect(isProbeableUrl('data:audio/mp4;base64,AAAA', ORIGIN)).toBe(false);
  });
});

describe('isBadProbeStatus', () => {
  it('flags 401, 403, 404, 410 and every 5xx', () => {
    for (const status of [401, 403, 404, 410, 500, 503]) {
      expect(isBadProbeStatus(status)).toBe(true);
    }
  });

  it('passes 200, 206, 416, network, skipped and none', () => {
    for (const status of [200, 206, 416, 'network', 'skipped', undefined] as const) {
      expect(isBadProbeStatus(status)).toBe(false);
    }
  });
});

describe('probeVoiceUrl', () => {
  it('never fetches a cross-origin url: skipped', async () => {
    const fetcher = vi.fn();
    const status = await probeVoiceUrl('https://r2.example/a', ORIGIN, fetcher);
    expect(status).toBe('skipped');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks for two bytes with a 5 s limit, reads the status and cancels the body', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const fetcher = vi.fn(async () => ({ status: 404, body: { cancel } }) as unknown as Response);
    const status = await probeVoiceUrl('https://srtd.io/f/v1/full?k=a', ORIGIN, fetcher);
    expect(status).toBe(404);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init, , options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
      unknown,
      { timeoutMs: number },
    ];
    expect(url).toBe('https://srtd.io/f/v1/full?k=a');
    expect(new Headers(init.headers).get('Range')).toBe('bytes=0-1');
    expect(options.timeoutMs).toBe(VOICE_PROBE_TIMEOUT_MS);
    expect(VOICE_PROBE_TIMEOUT_MS).toBe(5_000);
  });

  it('a rejected fetch (network or the time limit) reads as network', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Load failed');
    });
    expect(await probeVoiceUrl('https://srtd.io/f/v1/full?k=a', ORIGIN, fetcher)).toBe('network');
  });
});
