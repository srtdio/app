import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushChannel } from '@/lib/inbox/inbox-push';
import {
  PLAN_LIVE_EVENT,
  PLAN_LIVE_SETTLE_MS,
  planLiveTopic,
  subscribePlanLive,
  type PlanLiveClient,
} from '@/lib/chat/plan-live';

interface Fake {
  client: PlanLiveClient;
  fire: () => void;
  topics: string[];
  removed: number;
}

function fakeClient(token: string | null = 'jwt'): Fake {
  let handler: (() => void) | null = null;
  const state: Fake = {
    topics: [],
    removed: 0,
    fire: () => handler?.(),
    client: {
      channel: (name) => {
        state.topics.push(name);
        const ch: PushChannel = {
          on: (_type, filter, cb) => {
            if (filter.event === PLAN_LIVE_EVENT) handler = () => cb({});
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

describe('plan-live', () => {
  it('names the private topic by plan id', () => {
    expect(planLiveTopic('p1')).toBe('plan:p1');
  });

  it('turns a burst of changes into one call', async () => {
    const fake = fakeClient();
    const onChange = vi.fn();
    subscribePlanLive(fake.client, 'p1', onChange);
    await vi.runAllTimersAsync();
    expect(fake.topics).toEqual(['plan:p1']);
    fake.fire();
    fake.fire();
    fake.fire();
    vi.advanceTimersByTime(PLAN_LIVE_SETTLE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stops: removes the channel and drops a pending call', async () => {
    const fake = fakeClient();
    const onChange = vi.fn();
    const stop = subscribePlanLive(fake.client, 'p1', onChange);
    await vi.runAllTimersAsync();
    fake.fire();
    stop();
    vi.advanceTimersByTime(PLAN_LIVE_SETTLE_MS);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.removed).toBe(1);
  });

  it('never subscribes without a session', async () => {
    const fake = fakeClient(null);
    subscribePlanLive(fake.client, 'p1', vi.fn());
    await vi.runAllTimersAsync();
    expect(fake.topics).toEqual([]);
  });
});
