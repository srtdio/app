// The recent titles warm-up, counted on a recording client. A recent whose
// read did not return it (deleted, no access, untitled) used to be asked for
// again on every route change; it is now asked once per session. A route that
// records nothing schedules no warm-up at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  WARM_DEBOUNCE_MS,
  createTitleWarmer,
  readRecents,
  recordRecent,
  recordRouteOpen,
  resetTitleMisses,
  type RecentStorage,
} from '@/lib/recent-items';

const WS = '0190a000-0000-7000-8000-00000000a001';
const ME = '0190a000-0000-7000-8000-000000000001';

function memoryStorage(): RecentStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** Every .in() read, by table; rows answered by table (`fail`: that table errors). */
function recordingClient(
  tables: Record<string, Array<Record<string, unknown>>>,
  fail: readonly string[] = [],
) {
  const calls: Array<{ table: string; ids: string[] }> = [];
  const from = (table: string) => {
    let ids: string[] = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: (_col: string, values: string[]) => {
        ids = values;
        calls.push({ table, ids: values });
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        const rows = (tables[table] ?? []).filter((r) => ids.includes(String(r.id)));
        resolve(
          fail.includes(table)
            ? { data: null, error: { message: 'boom' } }
            : { data: rows, error: null },
        );
      },
    };
    return chain;
  };
  return { client: { from } as unknown as Client, calls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function warmerOver(client: Client, storage: RecentStorage) {
  return createTitleWarmer({
    client,
    workspaceId: WS,
    workspaceKey: 'GBL',
    userId: ME,
    storage: () => storage,
    idle: (run) => {
      run();
      return () => {};
    },
  });
}

async function warm(warmer: { schedule: () => void }): Promise<void> {
  warmer.schedule();
  vi.advanceTimersByTime(WARM_DEBOUNCE_MS);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTitleMisses();
});

afterEach(() => vi.useRealTimers());

describe('title warm-up: a not-found recent is asked once per session', () => {
  it('a deleted post is read once; the next route changes read nothing for it', async () => {
    const s = memoryStorage();
    const { client, calls } = recordingClient({ posts: [] });
    const warmer = warmerOver(client, s);
    recordRecent(s, ME, WS, { type: 'post', id: 'p-gone' }, 1);
    await warm(warmer);
    expect(calls).toEqual([{ table: 'posts', ids: ['p-gone'] }]);
    for (let i = 0; i < 5; i += 1) await warm(warmer);
    expect(calls).toHaveLength(1);
    // It stays in the list (the session refresh is what drops it).
    expect(readRecents(s, ME, WS).map((i) => i.id)).toEqual(['p-gone']);
    // A new item still reads, without the missing one.
    recordRecent(s, ME, WS, { type: 'post', id: 'p2' }, 2);
    await warm(warmer);
    expect(calls[1]).toEqual({ table: 'posts', ids: ['p2'] });
    warmer.dispose();
  });

  it('an untitled plan is asked once too', async () => {
    const s = memoryStorage();
    const { client, calls } = recordingClient({ plans: [{ id: 'pl1', title: '' }] });
    const warmer = warmerOver(client, s);
    recordRecent(s, ME, WS, { type: 'plan', id: 'pl1' }, 1);
    await warm(warmer);
    await warm(warmer);
    expect(calls).toHaveLength(1);
    warmer.dispose();
  });

  it('a failed read is not a not-found: the next warm-up asks again', async () => {
    const s = memoryStorage();
    const { client, calls } = recordingClient({}, ['posts']);
    const warmer = warmerOver(client, s);
    recordRecent(s, ME, WS, { type: 'post', id: 'p1' }, 1);
    await warm(warmer);
    await warm(warmer);
    expect(calls).toHaveLength(2);
    warmer.dispose();
  });
});

describe('recordRouteOpen: whether the route recorded anything', () => {
  const base = {
    storage: memoryStorage(),
    search: '',
    workspaceId: WS,
    workspaceKey: 'GBL',
    userId: ME,
    nowMs: 1,
  };

  it('a route with nothing to record: false, and no read', async () => {
    const { client, calls } = recordingClient({});
    for (const pathname of ['/pipeline', '/briefs', '/chat', '/notifications', '/assets']) {
      expect(await recordRouteOpen({ ...base, client, pathname })).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('an item route: true', async () => {
    const { client } = recordingClient({});
    expect(await recordRouteOpen({ ...base, client, pathname: '/posts/p1' })).toBe(true);
  });
});
