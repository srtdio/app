// chat_unread_counts at start: the first list load reads the counts, and the
// connecting -> connected step used to read them again at once. Counted on a
// fake reader: one read at start; a real reconnect later still re-reads.
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { UNREAD_CONNECT_SKIP_MS, connectRefreshWanted } from '@/components/chat/ChatStoreProvider';
import { createReadTracker } from '@/lib/wake-read';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('unread counts on connect', () => {
  it('one chat_unread_counts read at start, the connect before or after it', async () => {
    let at = 0;
    let reads = 0;
    const tracker = createReadTracker(UNREAD_CONNECT_SKIP_MS, () => at);
    const read = (): Promise<void> => {
      reads += 1;
      const d = deferred();
      void tracker.track(d.promise);
      return Promise.resolve().then(() => d.resolve());
    };
    const onStatus = (previous: 'connecting' | 'connected', status: 'connected'): void => {
      if (connectRefreshWanted(previous, status, tracker.fresh())) void read();
    };
    // The list load's counts read, then the connect while it is out.
    void read();
    onStatus('connecting', 'connected');
    expect(reads).toBe(1);
    await flush();
    // A connect just after it settled: still the same answer.
    at = UNREAD_CONNECT_SKIP_MS - 1;
    onStatus('connecting', 'connected');
    expect(reads).toBe(1);
  });

  it('a real reconnect later re-reads', async () => {
    let at = 0;
    const tracker = createReadTracker(UNREAD_CONNECT_SKIP_MS, () => at);
    await tracker.track(Promise.resolve());
    at = UNREAD_CONNECT_SKIP_MS + 60_000;
    expect(connectRefreshWanted('reconnecting', 'connected', tracker.fresh())).toBe(true);
  });

  it('only a step into connected asks', () => {
    expect(connectRefreshWanted('connected', 'connected', false)).toBe(false);
    expect(connectRefreshWanted('connected', 'reconnecting', false)).toBe(false);
    expect(connectRefreshWanted('connecting', 'connected', false)).toBe(true);
  });
});
