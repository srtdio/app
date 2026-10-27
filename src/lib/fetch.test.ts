import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  defaultTimeoutFor,
  fetchWithTrace,
  NO_LIMIT_FUNCTIONS,
  NO_LIMIT_RPCS,
  REQUEST_TIMEOUT_MS,
} from '@/lib/fetch';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';

// A fetch that never answers on its own: it rejects with the signal's reason
// once the (real) AbortSignal it was handed aborts, as the browser's does.
const seen: Array<AbortSignal | undefined> = [];
const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
  const signal = init?.signal ?? undefined;
  seen.push(signal);
  return new Promise<Response>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
});

const URL_RPC = 'https://test.supabase.co/rest/v1/rpc/posts_list';

beforeEach(() => {
  vi.useFakeTimers();
  seen.length = 0;
  hangingFetch.mockClear();
  vi.stubGlobal('fetch', hangingFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Outcome {
  state: 'pending' | 'resolved' | 'rejected';
  reason: unknown;
}

/** Settles the promise into a readable outcome without an unhandled rejection. */
function track(p: Promise<unknown>): Outcome {
  const out: Outcome = { state: 'pending', reason: undefined };
  p.then(
    () => {
      out.state = 'resolved';
    },
    (reason: unknown) => {
      out.state = 'rejected';
      out.reason = reason;
    },
  );
  return out;
}

describe('fetchWithTrace default ceiling', () => {
  it('is 10 000 ms', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('rejects with a TimeoutError at 10 s, not before', async () => {
    const out = track(fetchWithTrace(URL_RPC));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(out.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(out.state).toBe('rejected');
    expect((out.reason as Error).name).toBe('TimeoutError');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('still sends X-Trace-Id', async () => {
    void track(fetchWithTrace(URL_RPC, undefined, 'trace-1'));
    const init = hangingFetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('X-Trace-Id')).toBe('trace-1');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  });

  it('clears its timer once the response arrives', async () => {
    hangingFetch.mockImplementationOnce(async () => new Response('ok'));
    const res = await fetchWithTrace(URL_RPC);
    expect(res.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the request fails first', async () => {
    hangingFetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchWithTrace(URL_RPC)).rejects.toThrow('Failed to fetch');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each([
  ['AbortSignal.any', false],
  ['the manual fallback (no AbortSignal.any)', true],
])('a caller signal combined via %s', (_label, removeAny) => {
  const original = (AbortSignal as { any?: unknown }).any;
  beforeEach(() => {
    if (removeAny) (AbortSignal as { any?: unknown }).any = undefined;
  });
  afterEach(() => {
    (AbortSignal as { any?: unknown }).any = original;
  });

  it('aborts the request when the caller aborts first', async () => {
    const caller = new AbortController();
    const out = track(fetchWithTrace(URL_RPC, { signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.state).toBe('rejected');
    expect((out.reason as Error).name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an already-aborted caller signal rejects at once', async () => {
    const caller = new AbortController();
    caller.abort();
    const out = track(fetchWithTrace(URL_RPC, { signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.state).toBe('rejected');
    expect((out.reason as Error).name).toBe('AbortError');
  });

  it('times out at 10 s when the caller never aborts', async () => {
    const caller = new AbortController();
    const out = track(fetchWithTrace(URL_RPC, { signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(out.state).toBe('rejected');
    expect((out.reason as Error).name).toBe('TimeoutError');
    expect(caller.signal.aborted).toBe(false);
  });
});

describe('a shorter caller ceiling wins', () => {
  it("withReadTimeout's 5 s aborts the request before the 10 s default", async () => {
    const result = withReadTimeout((signal) =>
      fetchWithTrace(URL_RPC, { signal }).then(() => ({ ok: true as const, data: null })),
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(await result).toMatchObject({ ok: false });
    expect(seen[0]?.aborted).toBe(true);
    // The caller's AbortError, not the default's TimeoutError.
    expect((seen[0]?.reason as Error).name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('per-call timeout option', () => {
  it('timeoutMs: null opts out: no ceiling and no signal added', async () => {
    const out = track(fetchWithTrace(URL_RPC, undefined, undefined, { timeoutMs: null }));
    await vi.advanceTimersByTimeAsync(10 * REQUEST_TIMEOUT_MS);
    expect(out.state).toBe('pending');
    expect(seen[0]).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a number sets this call its own ceiling', async () => {
    const out = track(fetchWithTrace(URL_RPC, undefined, undefined, { timeoutMs: 3_000 }));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(out.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(out.state).toBe('rejected');
    expect((out.reason as Error).name).toBe('TimeoutError');
  });
});

describe('defaultTimeoutFor', () => {
  const base = 'https://test.supabase.co';

  it('gives reads and idempotent writes the 10 s ceiling', () => {
    for (const path of [
      '/rest/v1/rpc/posts_list',
      '/rest/v1/rpc/chat_message_send',
      '/rest/v1/user_profiles?select=*',
      '/auth/v1/token?grant_type=refresh_token',
      '/functions/v1/invite-accept',
    ]) {
      expect(defaultTimeoutFor(`${base}${path}`)).toBe(REQUEST_TIMEOUT_MS);
    }
  });

  it('keeps no ceiling for writes a retry could apply twice', () => {
    for (const rpc of NO_LIMIT_RPCS) {
      expect(defaultTimeoutFor(`${base}/rest/v1/rpc/${rpc}`)).toBeNull();
    }
    for (const fn of NO_LIMIT_FUNCTIONS) {
      expect(defaultTimeoutFor(`${base}/functions/v1/${fn}`)).toBeNull();
    }
    expect(NO_LIMIT_RPCS.has('comment_create')).toBe(true);
    expect(NO_LIMIT_RPCS.has('stage_transition')).toBe(true);
    expect(NO_LIMIT_FUNCTIONS.has('invite-send')).toBe(true);
  });

  it('a no-limit write through fetchWithTrace never times out', async () => {
    const out = track(fetchWithTrace(`${base}/rest/v1/rpc/comment_create`, { method: 'POST' }));
    await vi.advanceTimersByTimeAsync(10 * REQUEST_TIMEOUT_MS);
    expect(out.state).toBe('pending');
  });
});
