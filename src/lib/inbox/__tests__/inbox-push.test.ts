// Activity push (inbox-push.ts): nudges run the inbox tick at most once per
// second with one follow-up queued behind an in-flight tick; a nudge for
// another workspace never ticks the active one; the channel stops on sign-out
// and user switch; TOKEN_REFRESHED re-sends the token; the poll returns to 30s
// when the channel errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNOUT_EVENT } from '@/lib/events';
import {
  POLL_MS,
  createTickGate,
  inboxTopic,
  intervalsPerTick,
  nudgeTicks,
  nudgeWorkspace,
  subscribeInboxPush,
  type InboxPushHandlers,
  type PushChannel,
  type PushClient,
} from '@/lib/inbox/inbox-push';

const WS = 'ws-active';
const OTHER_WS = 'ws-other';
const USER = 'user-a';

interface FakeClient extends PushClient {
  setAuthCalls: Array<string | null | undefined>;
  channels: Array<{ name: string; private: boolean }>;
  removed: number;
  authUnsubscribed: number;
  emitAuth: (event: string, session: { access_token: string } | null) => void;
  emitStatus: (status: string) => void;
  emitBroadcast: (payload: unknown) => void;
}

function fakeClient(): FakeClient {
  let authCb: ((event: string, session: { access_token: string } | null) => void) | null = null;
  let statusCb: ((status: string) => void) | null = null;
  let broadcastCb: ((message: { payload?: unknown }) => void) | null = null;
  const channel: PushChannel = {
    on(_type, _filter, callback) {
      broadcastCb = callback;
      return channel;
    },
    subscribe(callback) {
      statusCb = callback;
      return channel;
    },
  };
  const client: FakeClient = {
    setAuthCalls: [],
    channels: [],
    removed: 0,
    authUnsubscribed: 0,
    channel(name, opts) {
      client.channels.push({ name, private: opts.config.private });
      return channel;
    },
    removeChannel() {
      client.removed += 1;
      return Promise.resolve('ok');
    },
    realtime: {
      setAuth(token) {
        client.setAuthCalls.push(token);
        return Promise.resolve();
      },
    },
    auth: {
      onAuthStateChange(callback) {
        authCb = callback;
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                client.authUnsubscribed += 1;
              },
            },
          },
        };
      },
    },
    emitAuth: (event, session) => authCb?.(event, session),
    emitStatus: (status) => statusCb?.(status),
    emitBroadcast: (payload) => broadcastCb?.({ payload }),
  };
  return client;
}

function handlers(overrides: Partial<InboxPushHandlers> = {}): InboxPushHandlers {
  return { onNudge: vi.fn(), onLive: vi.fn(), onSubscribed: vi.fn(), ...overrides };
}

/** Let the setAuth-then-subscribe chain settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createTickGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a nudge triggers exactly one tick', async () => {
    const run = vi.fn(() => Promise.resolve());
    const gate = createTickGate(run);
    gate.nudge();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('10 nudges in 1 s trigger at most 2 ticks', async () => {
    const run = vi.fn(() => Promise.resolve());
    const gate = createTickGate(run);
    for (let i = 0; i < 10; i += 1) {
      gate.nudge();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(run.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('a nudge during an in-flight tick queues exactly one follow-up', async () => {
    let release: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const gate = createTickGate(run);
    gate.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    gate.nudge();
    gate.nudge();
    gate.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs nothing after dispose', async () => {
    const run = vi.fn(() => Promise.resolve());
    const gate = createTickGate(run);
    gate.nudge();
    gate.nudge();
    gate.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    gate.nudge();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('nudge routing', () => {
  it('reads only the workspace id from the payload', () => {
    expect(nudgeWorkspace({ w: WS })).toBe(WS);
    expect(nudgeWorkspace(null)).toBeNull();
    expect(nudgeWorkspace({ w: 3 })).toBeNull();
    expect(nudgeWorkspace('x')).toBeNull();
  });

  it('a nudge for another workspace does not tick the active one', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const run = vi.fn(() => Promise.resolve());
      const gate = createTickGate(run);
      subscribeInboxPush(
        client,
        USER,
        'token-1',
        handlers({
          onNudge: (payload) => {
            if (nudgeTicks(payload, WS)) gate.nudge();
          },
        }),
        new EventTarget(),
      );
      await settle();
      client.emitBroadcast({ w: OTHER_WS });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).not.toHaveBeenCalled();
      client.emitBroadcast({ w: WS });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('subscribeInboxPush', () => {
  it('sets auth before subscribing one private channel on inbox:<user>', async () => {
    const client = fakeClient();
    subscribeInboxPush(client, USER, 'token-1', handlers(), new EventTarget());
    expect(client.setAuthCalls).toEqual(['token-1']);
    await settle();
    expect(client.channels).toEqual([{ name: inboxTopic(USER), private: true }]);
  });

  it('token refresh calls setAuth with the new token', async () => {
    const client = fakeClient();
    subscribeInboxPush(client, USER, 'token-1', handlers(), new EventTarget());
    await settle();
    client.emitAuth('TOKEN_REFRESHED', { access_token: 'token-2' });
    expect(client.setAuthCalls).toEqual(['token-1', 'token-2']);
  });

  it('unsubscribes on sorted:signout', async () => {
    const client = fakeClient();
    const target = new EventTarget();
    subscribeInboxPush(client, USER, 'token-1', handlers(), target);
    await settle();
    target.dispatchEvent(new Event(SIGNOUT_EVENT));
    expect(client.removed).toBe(1);
    expect(client.authUnsubscribed).toBe(1);
  });

  it('unsubscribes on SIGNED_OUT', async () => {
    const client = fakeClient();
    const h = handlers();
    subscribeInboxPush(client, USER, 'token-1', h, new EventTarget());
    await settle();
    client.emitAuth('SIGNED_OUT', null);
    expect(client.removed).toBe(1);
    client.emitBroadcast({ w: WS });
    expect(h.onNudge).not.toHaveBeenCalled();
  });

  it('a user switch stops the old channel before the new one subscribes', async () => {
    const client = fakeClient();
    const target = new EventTarget();
    const stopA = subscribeInboxPush(client, 'user-a', 'token-a', handlers(), target);
    await settle();
    stopA();
    expect(client.removed).toBe(1);
    subscribeInboxPush(client, 'user-b', 'token-b', handlers(), target);
    await settle();
    expect(client.channels.map((c) => c.name)).toEqual([
      inboxTopic('user-a'),
      inboxTopic('user-b'),
    ]);
    // A second stop is a no-op.
    stopA();
    expect(client.removed).toBe(1);
  });

  it('a stop before setAuth settles never subscribes', async () => {
    const client = fakeClient();
    const stop = subscribeInboxPush(client, USER, 'token-1', handlers(), new EventTarget());
    stop();
    await settle();
    expect(client.channels).toEqual([]);
  });

  it('reports first and re-SUBSCRIBED, and live state', async () => {
    const client = fakeClient();
    const h = handlers();
    subscribeInboxPush(client, USER, 'token-1', h, new EventTarget());
    await settle();
    client.emitStatus('SUBSCRIBED');
    client.emitStatus('CHANNEL_ERROR');
    client.emitStatus('SUBSCRIBED');
    expect(h.onSubscribed).toHaveBeenNthCalledWith(1, true);
    expect(h.onSubscribed).toHaveBeenNthCalledWith(2, false);
    expect(h.onLive).toHaveBeenNthCalledWith(1, true);
    expect(h.onLive).toHaveBeenNthCalledWith(2, false);
    expect(h.onLive).toHaveBeenNthCalledWith(3, true);
  });
});

describe('poll fallback', () => {
  it('returns to 30 s visible on channel error, close or timeout', async () => {
    const client = fakeClient();
    let live = false;
    subscribeInboxPush(
      client,
      USER,
      'token-1',
      handlers({
        onLive: (l) => {
          live = l;
        },
      }),
      new EventTarget(),
    );
    await settle();
    client.emitStatus('SUBSCRIBED');
    expect(intervalsPerTick(false, live) * POLL_MS).toBe(120_000);
    for (const status of ['CHANNEL_ERROR', 'CLOSED', 'TIMED_OUT']) {
      client.emitStatus('SUBSCRIBED');
      client.emitStatus(status);
      expect(intervalsPerTick(false, live) * POLL_MS).toBe(30_000);
    }
  });

  it('keeps the hidden poll at 60 s', () => {
    expect(intervalsPerTick(true, false) * POLL_MS).toBe(60_000);
    expect(intervalsPerTick(true, true) * POLL_MS).toBe(60_000);
  });
});
