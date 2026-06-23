import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runThumbnailLoad,
  thumbnailRetryDelayMs,
  THUMBNAIL_RETRY_CAP,
  type ThumbnailLoadCallbacks,
} from '@/components/media/use-thumbnail';
import type { PresignedUrl } from '@/lib/asset-presign';

// The repo's vitest runs in the node environment and ships no jsdom dependency,
// so there is no hook-render harness that runs effects (Thumbnail.test.tsx renders
// to static markup, which never fires effects). Rather than stand up a brittle
// harness or add a dependency, the retry/refresh loop lives in runThumbnailLoad,
// a React-free function the effect delegates to, exercised here with a fake cache
// and fake timers - the same seam flash-node.test.ts uses for its timer logic.

const ONE_HOUR = 60 * 60 * 1000;

/** A cache whose resolve rejects its first `failures` calls, then resolves `url`. */
function makeCache(failures: number, url: string): { resolve: ReturnType<typeof vi.fn> } {
  let calls = 0;
  const resolve = vi.fn(
    (): Promise<PresignedUrl> => {
      calls += 1;
      if (calls <= failures) {
        // The unauthenticated first presign the retry exists to recover from.
        return Promise.reject(new Error('unauthenticated'));
      }
      return Promise.resolve({ url, expiresAt: Date.now() + ONE_HOUR });
    },
  );
  return { resolve };
}

/** State sinks plus the values runThumbnailLoad last wrote to them. */
function makeSinks(): {
  callbacks: ThumbnailLoadCallbacks;
  state: { url: string | null; failed: boolean };
  setUrl: ReturnType<typeof vi.fn>;
  setFailed: ReturnType<typeof vi.fn>;
} {
  const state = { url: null as string | null, failed: false };
  const setUrl = vi.fn((u: string) => {
    state.url = u;
  });
  const setFailed = vi.fn((f: boolean) => {
    state.failed = f;
  });
  return { callbacks: { setUrl, setFailed }, state, setUrl, setFailed };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('thumbnailRetryDelayMs', () => {
  it('is a linear 700ms-per-attempt backoff', () => {
    expect(thumbnailRetryDelayMs(1)).toBe(700);
    expect(thumbnailRetryDelayMs(2)).toBe(1400);
    expect(thumbnailRetryDelayMs(3)).toBe(2100);
  });
});

describe('runThumbnailLoad', () => {
  it('self-heals: two failed presigns then a success ends with the url and failed=false', async () => {
    const cache = makeCache(2, 'https://cdn.example/heal.jpg');
    const { callbacks, state, setUrl, setFailed } = makeSinks();

    const cancel = runThumbnailLoad('av1', cache, callbacks);

    // First attempt fails -> schedule retry 1 at 700ms.
    await vi.advanceTimersByTimeAsync(0);
    expect(state.failed).toBe(false);
    // Retry 1 fails -> schedule retry 2 at 1400ms.
    await vi.advanceTimersByTimeAsync(thumbnailRetryDelayMs(1));
    // Retry 2 succeeds.
    await vi.advanceTimersByTimeAsync(thumbnailRetryDelayMs(2));

    expect(cache.resolve).toHaveBeenCalledTimes(3);
    expect(state.url).toBe('https://cdn.example/heal.jpg');
    expect(state.failed).toBe(false);
    expect(setUrl).toHaveBeenCalledWith('https://cdn.example/heal.jpg');
    // setFailed(true) is never called on the recovery path.
    expect(setFailed.mock.calls.some(([f]) => f === true)).toBe(false);

    cancel();
  });

  it('sets failed=true only after the retry cap is exhausted (up to 4 total attempts)', async () => {
    const cache = makeCache(Number.POSITIVE_INFINITY, 'never');
    const { callbacks, state, setFailed } = makeSinks();

    const cancel = runThumbnailLoad('av2', cache, callbacks);

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails -> retry scheduled
    for (let attempt = 1; attempt <= THUMBNAIL_RETRY_CAP; attempt += 1) {
      // Each retry must not have given up yet until the last one fires.
      expect(state.failed).toBe(false);
      await vi.advanceTimersByTimeAsync(thumbnailRetryDelayMs(attempt));
    }

    // 1 initial attempt + THUMBNAIL_RETRY_CAP retries.
    expect(cache.resolve).toHaveBeenCalledTimes(THUMBNAIL_RETRY_CAP + 1);
    expect(state.failed).toBe(true);
    expect(setFailed).toHaveBeenLastCalledWith(true);

    cancel();
  });

  it('cancel stops the retry: no further resolve calls or state writes fire after unmount', async () => {
    const cache = makeCache(Number.POSITIVE_INFINITY, 'never');
    const { callbacks, setUrl, setFailed } = makeSinks();

    const cancel = runThumbnailLoad('av3', cache, callbacks);
    await vi.advanceTimersByTimeAsync(0); // first attempt fails, retry pending
    expect(cache.resolve).toHaveBeenCalledTimes(1);

    cancel();
    await vi.advanceTimersByTimeAsync(10_000); // advance well past every backoff

    expect(cache.resolve).toHaveBeenCalledTimes(1);
    expect(setFailed).not.toHaveBeenCalledWith(true);
    expect(setUrl).not.toHaveBeenCalled();
  });
});
