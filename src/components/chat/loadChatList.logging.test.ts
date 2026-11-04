import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';

// The provider's import graph pulls the real agora-chat browser SDK.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ logger: log }));

import { loadChatList, type ChatListReaders } from '@/components/chat/ChatStoreProvider';
import {
  LATE_READ_GRACE_MS,
  READ_TIMEOUT_MS,
  RETRY_DELAY_MS,
  RETRY_JITTER_MS,
} from '@/lib/chat-reads';
import { requestTimeoutOf } from '@/lib/fetch';

const SCOPE = 'u1:ws1';
const ME = 'u1';

function ok<T>(data: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, data });
}

function readers(over: Partial<ChatListReaders> = {}): ChatListReaders {
  return {
    roster: () => ok([]),
    clears: () => ok([]),
    previews: () => ok([]),
    counts: () => ok([]),
    ...over,
  };
}

/** A read that answers only when `land` is called (or never). */
function held<T>(): { read: () => Promise<Result<T>>; land: (data: T) => void } {
  let land: (data: T) => void = () => {};
  const promise = new Promise<Result<T>>((resolve) => {
    land = (data) => resolve({ ok: true, data });
  });
  return { read: () => promise, land };
}

const FAILED = 'chat store: initial load failed';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadChatList logging (FRONTEND-A)', () => {
  it('a timeout-only failure logs a warning, not an error', async () => {
    const roster = held<never[]>();
    const pending = loadChatList(readers({ roster: roster.read }), SCOPE, ME);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await pending;
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'chat store: initial load timed out',
      expect.objectContaining({ roster: 'read timed out', clears: 'ok' }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a late delivery logs no error, before or after the grace end', async () => {
    const roster = held<never[]>();
    const onLate = vi.fn();
    const pending = loadChatList(readers({ roster: roster.read }), SCOPE, ME, undefined, {
      onLate,
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await pending;
    roster.land([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('the grace end with only timeouts logs a warning once, never an error', async () => {
    const roster = held<never[]>();
    const counts = held<never[]>();
    const pending = loadChatList(readers({ roster: roster.read, counts: counts.read }), SCOPE, ME);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await pending;
    expect(log.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      FAILED,
      expect.objectContaining({ roster: 'read timed out', counts: 'read timed out' }),
    );
    expect(log.warn.mock.calls.filter(([msg]) => msg === FAILED)).toHaveLength(1);
  });

  it('a non-timeout error logs the error at once', async () => {
    const pending = loadChatList(
      readers({
        clears: () =>
          Promise.resolve<Result<never[]>>({
            ok: false,
            error: { code: 'unknown', message: 'boom' },
          }),
      }),
      SCOPE,
      ME,
    );
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(FAILED, expect.objectContaining({ clears: 'boom' }));
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

const failure = (message: string): Promise<Result<never[]>> =>
  Promise.resolve({ ok: false, error: { code: 'unknown', message } });
const RETRY_WINDOW_MS = RETRY_DELAY_MS + RETRY_JITTER_MS;

describe('loadChatList retry and final reasons (FRONTEND-A, FRONTEND-P)', () => {
  it('each read gets the late grace as its request ceiling, not the 10 s default', async () => {
    const seen: AbortSignal[] = [];
    const record = (signal: AbortSignal): Promise<Result<never[]>> => {
      seen.push(signal);
      return ok([]);
    };
    await loadChatList(
      readers({ roster: record, clears: record, previews: record, counts: record }),
      SCOPE,
      ME,
    );
    expect(seen).toHaveLength(4);
    for (const signal of seen) expect(requestTimeoutOf(signal)).toBe(LATE_READ_GRACE_MS);
  });

  it('a network failure is retried once and the retry delivers the list, with no error', async () => {
    const clears = vi
      .fn<(signal: AbortSignal) => Promise<Result<never[]>>>()
      .mockReturnValueOnce(failure('listChannelClears: TypeError: Failed to fetch'))
      .mockReturnValue(ok([]));
    const onLate = vi.fn();
    const transition = await loadChatList(readers({ clears }), SCOPE, ME, undefined, { onLate });
    expect(transition).toBeTypeOf('function');
    // The failure is still running (retry pending): a warning only.
    expect(log.warn).toHaveBeenCalledWith('chat store: initial load timed out', expect.anything());
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
    expect(clears).toHaveBeenCalledTimes(2);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('two network failures give up as a warning with the final reason', async () => {
    const counts = vi
      .fn<(signal: AbortSignal) => Promise<Result<never[]>>>()
      .mockReturnValueOnce(failure('loadUnreadCounts: AbortError: signal is aborted'))
      .mockReturnValue(failure('loadUnreadCounts: TypeError: Load failed'));
    await loadChatList(readers({ counts }), SCOPE, ME);
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
    expect(counts).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      FAILED,
      expect.objectContaining({ counts: 'loadUnreadCounts: TypeError: Load failed', roster: 'ok' }),
    );
  });

  it('a late non-network failure overwrites "read timed out" and is an error', async () => {
    let answer: (r: Result<never[]>) => void = () => {};
    const roster = (): Promise<Result<never[]>> =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const pending = loadChatList(readers({ roster }), SCOPE, ME);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await pending;
    expect(log.warn).toHaveBeenCalledWith(
      'chat store: initial load timed out',
      expect.objectContaining({ roster: 'read timed out' }),
    );
    answer({
      ok: false,
      error: { code: 'unknown', message: 'listChannelSummaries: upstream 503' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      FAILED,
      expect.objectContaining({ roster: 'listChannelSummaries: upstream 503' }),
    );
  });

  it('a 4xx auth or permission failure is never retried and is an error at once', async () => {
    const previews = vi.fn(() => failure('previews: permission denied for table chat_messages'));
    await loadChatList(readers({ previews }), SCOPE, ME);
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(previews).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('onFailed fires once when the load resolves to the error transition, never on success', async () => {
    const onFailed = vi.fn();
    await loadChatList(readers(), SCOPE, ME, undefined, { onFailed });
    expect(onFailed).not.toHaveBeenCalled();
    await loadChatList(readers({ clears: () => failure('boom') }), SCOPE, ME, undefined, {
      onFailed,
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});
