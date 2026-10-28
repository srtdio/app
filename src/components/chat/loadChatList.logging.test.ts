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
import { LATE_READ_GRACE_MS, READ_TIMEOUT_MS } from '@/lib/chat-reads';

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

  it('the grace end with no data logs the error once', async () => {
    const roster = held<never[]>();
    const counts = held<never[]>();
    const pending = loadChatList(readers({ roster: roster.read, counts: counts.read }), SCOPE, ME);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await pending;
    expect(log.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      FAILED,
      expect.objectContaining({ roster: 'read timed out', counts: 'read timed out' }),
    );
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
