import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  backoffDelayMs,
  BACKOFF_CAP_MS,
  runChatConnection,
  type RunChatConnectionParams,
} from '@/lib/chat/controller';
import type { ChatConnection, ChatStatus, ChatTokenResult } from '@/lib/chat/types';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const token: Extract<ChatTokenResult, { ok: true }> = {
  ok: true,
  token: 'agora-token',
  expires_at: '2026-06-14T10:00:00.000Z',
  agora_username: 'u_abc',
  app_key: 'org#app',
};

/** Drain the fetchToken -> open microtask chain under fake timers. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

interface FakeConnection extends ChatConnection {
  handler: () => AgoraChat.EventHandlerType | null;
}

function fakeConnection(): FakeConnection {
  let captured: AgoraChat.EventHandlerType | null = null;
  return {
    open: vi.fn().mockResolvedValue({ accessToken: 'ok' }),
    close: vi.fn(),
    renewToken: vi.fn().mockResolvedValue({ status: true }),
    addEventHandler: vi.fn((_id: string, h: AgoraChat.EventHandlerType) => {
      captured = h;
    }),
    removeEventHandler: vi.fn(),
    handler: () => captured,
  };
}

interface Harness {
  params: RunChatConnectionParams;
  conns: FakeConnection[];
  latest: () => FakeConnection;
  createConnection: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setClient: ReturnType<typeof vi.fn>;
  removeSignout: ReturnType<typeof vi.fn>;
  removeWake: ReturnType<typeof vi.fn>;
  signout: () => void;
  wake: () => void;
  statuses: () => ChatStatus[];
}

function harness(
  fetchToken: () => Promise<ChatTokenResult>,
  build: () => FakeConnection = fakeConnection,
  isVisible: () => boolean = () => true,
): Harness {
  const conns: FakeConnection[] = [];
  const createConnection = vi.fn(() => {
    const conn = build();
    conns.push(conn);
    return conn;
  });
  const setStatus = vi.fn<(status: ChatStatus) => void>();
  const setClient = vi.fn<(client: ChatConnection | null) => void>();
  const removeSignout = vi.fn();
  const removeWake = vi.fn();
  let signoutHandler: () => void = () => {};
  let wakeHandler: () => void = () => {};
  return {
    params: {
      fetchToken,
      createConnection,
      setStatus,
      setClient,
      addSignoutListener: (handler) => {
        signoutHandler = handler;
        return removeSignout;
      },
      addWakeListener: (handler) => {
        wakeHandler = handler;
        return removeWake;
      },
      isVisible,
    },
    conns,
    latest: () => conns[conns.length - 1] as FakeConnection,
    createConnection,
    setStatus,
    setClient,
    removeSignout,
    removeWake,
    signout: () => signoutHandler(),
    wake: () => wakeHandler(),
    statuses: () => setStatus.mock.calls.map((c) => c[0]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelayMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelayMs)).toEqual([
      1000,
      2000,
      4000,
      8000,
      16000,
      30000,
      30000,
      BACKOFF_CAP_MS,
    ]);
  });
});

describe('runChatConnection open path', () => {
  it('opens with the worker username + token and reports connected', async () => {
    const h = harness(() => Promise.resolve(token));

    runChatConnection(h.params);
    await flush();

    expect(h.createConnection).toHaveBeenCalledWith('org#app');
    expect(h.latest().open).toHaveBeenCalledWith({ user: 'u_abc', accessToken: 'agora-token' });
    expect(h.statuses()).toEqual(['connecting', 'connected']);
    expect(h.setClient).toHaveBeenCalledWith(h.latest());
  });

  it('retries a failed token fetch with backoff instead of going unavailable', async () => {
    const fetchToken = vi
      .fn<() => Promise<ChatTokenResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'error' })
      .mockResolvedValue(token);
    const h = harness(fetchToken);

    runChatConnection(h.params);
    await flush();
    expect(h.statuses()).toEqual(['connecting', 'connecting']);
    expect(h.createConnection).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });
});

describe('runChatConnection retry loop', () => {
  it('backs off 1s, 2s, 4s ... 30s across consecutive open failures and resets once connected', async () => {
    let attempts = 0;
    const h = harness(
      () => Promise.resolve(token),
      () => {
        const conn = fakeConnection();
        attempts += 1;
        // Attempts 1..7 fail, the 8th opens.
        conn.open = attempts <= 7 ? vi.fn().mockRejectedValue(new Error('down')) : conn.open;
        return conn;
      },
    );

    runChatConnection(h.params);
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(1);
    expect(h.conns[0]?.close).toHaveBeenCalledOnce();

    for (const [delay, expected] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
      [8000, 5],
      [16000, 6],
      [30000, 7],
      [30000, 8],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.createConnection).toHaveBeenCalledTimes(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(h.createConnection).toHaveBeenCalledTimes(expected);
    }
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');

    // Reset: a disconnect after success schedules the FIRST delay again (1s).
    h.latest().handler()?.onDisconnected?.();
    expect(h.setStatus).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(h.createConnection).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(9);
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });

  it('never gives up: keeps retrying at the 30s cap long past ten failures', async () => {
    const h = harness(
      () => Promise.resolve(token),
      () => {
        const conn = fakeConnection();
        conn.open = vi.fn().mockRejectedValue(new Error('down'));
        return conn;
      },
    );

    runChatConnection(h.params);
    await flush();
    for (let i = 0; i < 25; i += 1) {
      await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
      await flush();
    }
    expect(h.createConnection.mock.calls.length).toBeGreaterThan(25);
    // Still armed at the cap: one more attempt 30s later.
    const before = h.createConnection.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(before + 1);
    expect(h.statuses()).not.toContain('unavailable');
    expect(h.setStatus).toHaveBeenLastCalledWith('connecting');
  });

  it('pauses the backoff while the tab is hidden and resumes on visible', async () => {
    let visible = true;
    const h = harness(
      () => Promise.resolve(token),
      () => {
        const conn = fakeConnection();
        conn.open = vi.fn().mockRejectedValue(new Error('down'));
        return conn;
      },
      () => visible,
    );

    runChatConnection(h.params);
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(1);
    visible = false;
    // The 1s timer fires while hidden: no attempt, and nothing re-armed.
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * 10);
    expect(h.createConnection).toHaveBeenCalledTimes(1);

    visible = true;
    h.wake();
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(2);
    // And the backoff continues from there while visible (2nd failure: 2s).
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.createConnection).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(3);
  });

  it('reports unavailable only for a 401/403 or unreachable token endpoint, and keeps retrying', async () => {
    const fetchToken = vi
      .fn<() => Promise<ChatTokenResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'auth' })
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
      .mockResolvedValueOnce({ ok: false, reason: 'error' })
      .mockResolvedValue(token);
    const h = harness(fetchToken);

    runChatConnection(h.params);
    await flush();
    expect(h.setStatus).toHaveBeenLastCalledWith('unavailable');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(h.setStatus).toHaveBeenLastCalledWith('unavailable');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    // A 5xx is transient: back to connecting, not unavailable.
    expect(h.setStatus).toHaveBeenLastCalledWith('connecting');
    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });

  it('stops retrying after a multi-login kick until the user taps reconnect', async () => {
    const h = harness(() => Promise.resolve(token));
    const handle = runChatConnection(h.params);
    await flush();
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');

    h.latest()
      .handler()
      ?.onDisconnected?.({ type: 206, message: 'logged in elsewhere' } as never);
    expect(h.setStatus).toHaveBeenLastCalledWith('kicked');
    expect(h.setClient).toHaveBeenLastCalledWith(null);
    expect(h.latest().close).toHaveBeenCalledOnce();

    // No backoff and no automatic wake reopens it.
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * 4);
    h.wake();
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(1);

    handle.retry();
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });

  it('treats an SDK onError kick (217) the same way', async () => {
    const h = harness(() => Promise.resolve(token));
    runChatConnection(h.params);
    await flush();
    h.latest()
      .handler()
      ?.onError?.({ type: 217, message: 'kicked' } as never);
    expect(h.setStatus).toHaveBeenLastCalledWith('kicked');
  });

  it('retries immediately on a wake signal (tab visible / online) while waiting', async () => {
    let attempts = 0;
    const h = harness(
      () => Promise.resolve(token),
      () => {
        const conn = fakeConnection();
        attempts += 1;
        if (attempts === 1) conn.open = vi.fn().mockRejectedValue(new Error('down'));
        return conn;
      },
    );

    runChatConnection(h.params);
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(1);

    h.wake();
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
    // The pending backoff timer was cleared: no third attempt fires later.
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
    expect(h.createConnection).toHaveBeenCalledTimes(2);
  });

  it('reports reconnecting on SDK reconnect/offline events and connected again on onConnected', async () => {
    const h = harness(() => Promise.resolve(token));
    runChatConnection(h.params);
    await flush();

    const handler = h.latest().handler();
    handler?.onReconnecting?.();
    expect(h.setStatus).toHaveBeenLastCalledWith('reconnecting');
    handler?.onConnected?.();
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
    handler?.onOffline?.();
    expect(h.setStatus).toHaveBeenLastCalledWith('reconnecting');
    handler?.onOnline?.();
    await flush();
    // onOnline attempts a fresh open when not live.
    expect(h.createConnection).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });
});

describe('runChatConnection teardown', () => {
  it('closes the connection and removes the listeners on signout', async () => {
    const h = harness(() => Promise.resolve(token));

    runChatConnection(h.params);
    await flush();
    h.signout();

    expect(h.latest().removeEventHandler).toHaveBeenCalledOnce();
    expect(h.latest().close).toHaveBeenCalledOnce();
    expect(h.removeSignout).toHaveBeenCalledOnce();
    expect(h.removeWake).toHaveBeenCalledOnce();
    expect(h.setClient).toHaveBeenLastCalledWith(null);
    expect(h.setStatus).toHaveBeenLastCalledWith('unavailable');
  });

  it('clears a pending retry timer when torn down (as on a workspace change)', async () => {
    const h = harness(
      () => Promise.resolve(token),
      () => {
        const conn = fakeConnection();
        conn.open = vi.fn().mockRejectedValue(new Error('down'));
        return conn;
      },
    );

    const handle = runChatConnection(h.params);
    await flush();
    handle.teardown();
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);

    expect(h.createConnection).toHaveBeenCalledTimes(1);
    expect(h.removeSignout).toHaveBeenCalledOnce();
    expect(h.setClient).toHaveBeenLastCalledWith(null);
  });
});

describe('runChatConnection tokens', () => {
  it('renews via onTokenWillExpire by fetching a fresh token and calling renewToken', async () => {
    const fetchToken = vi
      .fn<() => Promise<ChatTokenResult>>()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({ ...token, token: 'renewed-token' });
    const h = harness(fetchToken);

    runChatConnection(h.params);
    await flush();
    h.latest().handler()?.onTokenWillExpire?.();
    await flush();

    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(h.latest().renewToken).toHaveBeenCalledWith('renewed-token');
  });

  it('never closes the connection when the Supabase access token rotates; renewal reads the latest one', async () => {
    // The hook keys nothing on the access token: the getter simply returns
    // whatever the current session holds. Rotating it between calls must leave
    // the open connection untouched and only affect the next mint.
    let sessionToken = 'jwt-1';
    const fetchToken = vi.fn(() =>
      Promise.resolve({ ...token, token: `agora-for-${sessionToken}` }),
    );
    const h = harness(fetchToken);

    runChatConnection(h.params);
    await flush();
    const conn = h.latest();
    expect(conn.open).toHaveBeenCalledWith({ user: 'u_abc', accessToken: 'agora-for-jwt-1' });

    sessionToken = 'jwt-2';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.close).not.toHaveBeenCalled();
    expect(h.createConnection).toHaveBeenCalledTimes(1);

    conn.handler()?.onTokenWillExpire?.();
    await flush();
    expect(conn.renewToken).toHaveBeenCalledWith('agora-for-jwt-2');
    expect(conn.close).not.toHaveBeenCalled();
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });

  it('reopens with a fresh token when the SDK reports the token expired', async () => {
    const h = harness(() => Promise.resolve(token));
    runChatConnection(h.params);
    await flush();

    h.latest().handler()?.onTokenExpired?.();
    await flush();
    expect(h.createConnection).toHaveBeenCalledTimes(2);
    expect(h.conns[0]?.close).toHaveBeenCalledOnce();
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
  });
});
