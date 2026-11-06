import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushChannel } from '@/lib/inbox/inbox-push';
import { PLAN_LIVE_SETTLE_MS, type PlanLiveClient } from '@/lib/chat/plan-live';
import {
  BANK_LIVE_EVENT,
  BANK_LIVE_SETTLE_MS,
  bankLiveTopic,
  subscribeBankLive,
} from '@/lib/plan-tab/bank-live';

interface Fake {
  client: PlanLiveClient;
  fire: () => void;
  topics: string[];
  privates: boolean[];
  removed: number;
}

function fakeClient(token: string | null = 'jwt'): Fake {
  let handler: (() => void) | null = null;
  const state: Fake = {
    topics: [],
    privates: [],
    removed: 0,
    fire: () => handler?.(),
    client: {
      channel: (name, opts) => {
        state.topics.push(name);
        state.privates.push(opts.config.private);
        const ch: PushChannel = {
          on: (_type, filter, cb) => {
            if (filter.event === BANK_LIVE_EVENT) handler = () => cb({});
            return ch;
          },
          subscribe: () => undefined,
        };
        return ch;
      },
      removeChannel: () => {
        state.removed += 1;
      },
      realtime: { setAuth: () => undefined },
      auth: {
        getSession: () =>
          Promise.resolve({
            data: { session: token === null ? null : { access_token: token } },
          }),
      },
    },
  };
  return state;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('bank-live', () => {
  it('names the private topic by workspace id', () => {
    expect(bankLiveTopic('w1')).toBe('bank:w1');
  });

  it('settles like the Plan ping', () => {
    expect(BANK_LIVE_SETTLE_MS).toBe(PLAN_LIVE_SETTLE_MS);
    expect(BANK_LIVE_EVENT).toBe('changed');
  });

  it('subscribes privately on open and turns a burst into one call', async () => {
    const fake = fakeClient();
    const onChange = vi.fn();
    subscribeBankLive(fake.client, 'w1', onChange);
    await vi.runAllTimersAsync();
    expect(fake.topics).toEqual(['bank:w1']);
    expect(fake.privates).toEqual([true]);
    fake.fire();
    fake.fire();
    fake.fire();
    vi.advanceTimersByTime(BANK_LIVE_SETTLE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on close: removes the channel and drops a pending call', async () => {
    const fake = fakeClient();
    const onChange = vi.fn();
    const stop = subscribeBankLive(fake.client, 'w1', onChange);
    await vi.runAllTimersAsync();
    fake.fire();
    stop();
    vi.advanceTimersByTime(BANK_LIVE_SETTLE_MS);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.removed).toBe(1);
  });

  it('a close before the session resolves never subscribes', async () => {
    const fake = fakeClient();
    const stop = subscribeBankLive(fake.client, 'w1', vi.fn());
    stop();
    await vi.runAllTimersAsync();
    expect(fake.topics).toEqual([]);
  });

  it('no session: no subscription', async () => {
    const fake = fakeClient(null);
    subscribeBankLive(fake.client, 'w1', vi.fn());
    await vi.runAllTimersAsync();
    expect(fake.topics).toEqual([]);
  });
});
