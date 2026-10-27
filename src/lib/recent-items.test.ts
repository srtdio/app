import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  cachedEntries,
  clearRecents,
  createTitleWarmer,
  loadRecentEntries,
  recentsRefreshed,
  refreshRecentTitles,
  removeRecent,
  removeRecents,
  resetRecentsRefresh,
  writeRecentTitles,
  WARM_DEBOUNCE_MS,
  readRecents,
  recentFromRoute,
  recentKey,
  recordRecent,
  recordRouteOpen,
  RECENT_MAX,
  RECENT_SHOWN,
  type RecentItem,
  type RecentStorage,
} from '@/lib/recent-items';

const WS = '0190a000-0000-7000-8000-00000000a001';
const WS2 = '0190a000-0000-7000-8000-00000000a002';
const ME = '0190a000-0000-7000-8000-000000000001';
const OTHER = '0190a000-0000-7000-8000-000000000009';
const PEER = '0190a000-0000-7000-8000-000000000002';

function memoryStorage(): RecentStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function blockedStorage(): RecentStorage {
  const fail = (): never => {
    throw new Error('SecurityError');
  };
  return {
    getItem: fail,
    setItem: fail,
    removeItem: fail,
    key: fail,
    get length(): number {
      return fail();
    },
  };
}

describe('recents storage', () => {
  it('stores only {type, id, openedAt} until titles are cached, newest first, de-duplicated, max 20', () => {
    const s = memoryStorage();
    for (let i = 0; i < 25; i += 1) recordRecent(s, ME, WS, { type: 'post', id: `p${i}` }, i);
    recordRecent(s, ME, WS, { type: 'post', id: 'p20' }, 100);
    const items = readRecents(s, ME, WS);
    expect(items).toHaveLength(RECENT_MAX);
    expect(items[0]).toEqual({ type: 'post', id: 'p20', openedAt: 100 });
    expect(items.filter((i) => i.id === 'p20')).toHaveLength(1);
    const raw = JSON.parse(s.getItem(recentKey(ME, WS)) ?? '[]') as Array<Record<string, unknown>>;
    for (const row of raw) expect(Object.keys(row).sort()).toEqual(['id', 'openedAt', 'type']);
  });

  it('old items without a title still parse; a cached title and target round-trip', () => {
    const s = memoryStorage();
    s.setItem(
      recentKey(ME, WS),
      JSON.stringify([
        { type: 'post', id: 'p1', openedAt: 2 },
        { type: 'group', id: 'g1', openedAt: 1, title: 'Launch crew', target: { path: '/chat' } },
        // A broken cache entry is not an item.
        { type: 'post', id: 'bad', openedAt: 0, title: 7 },
      ]),
    );
    const items = readRecents(s, ME, WS);
    expect(items).toEqual([
      { type: 'post', id: 'p1', openedAt: 2 },
      { type: 'group', id: 'g1', openedAt: 1, title: 'Launch crew', target: { path: '/chat' } },
    ]);
    writeRecentTitles(
      s,
      ME,
      WS,
      [{ type: 'post', id: 'p1' }],
      {
        found: new Map([['post:p1', { title: 'Monday carousel', target: { path: '/p/gbl-1' } }]]),
        failed: new Set(),
      },
      false,
    );
    expect(readRecents(s, ME, WS)[0]).toEqual({
      type: 'post',
      id: 'p1',
      openedAt: 2,
      title: 'Monday carousel',
      target: { path: '/p/gbl-1' },
    });
    // A reopen keeps the cache; nothing beyond the five fields is stored.
    recordRecent(s, ME, WS, { type: 'post', id: 'p1' }, 9);
    expect(readRecents(s, ME, WS)[0]).toMatchObject({ openedAt: 9, title: 'Monday carousel' });
    const raw = JSON.parse(s.getItem(recentKey(ME, WS)) ?? '[]') as Array<Record<string, unknown>>;
    for (const row of raw) {
      for (const key of Object.keys(row)) {
        expect(['type', 'id', 'openedAt', 'title', 'target']).toContain(key);
      }
    }
    expect(cachedEntries(readRecents(s, ME, WS)).map((e) => e.title)).toEqual([
      'Monday carousel',
      'Launch crew',
    ]);
  });

  it('removeRecent and removeRecents remove only the listed items; a later open survives', () => {
    const s = memoryStorage();
    recordRecent(s, ME, WS, { type: 'post', id: 'p1' }, 1);
    recordRecent(s, ME, WS, { type: 'post', id: 'p2' }, 2);
    recordRecent(s, ME, WS, { type: 'brief', id: 'p2' }, 3);
    removeRecent(s, ME, WS, { type: 'post', id: 'p2' });
    expect(readRecents(s, ME, WS).map((i) => `${i.type}:${i.id}`)).toEqual(['brief:p2', 'post:p1']);
    // Clear all holds the list it cleared; p1 is opened again before the commit.
    const cleared = readRecents(s, ME, WS);
    recordRecent(s, ME, WS, { type: 'post', id: 'p1' }, 10);
    recordRecent(s, ME, WS, { type: 'plan', id: 'pl9' }, 11);
    removeRecents(s, ME, WS, cleared);
    expect(readRecents(s, ME, WS).map((i) => `${i.type}:${i.id}`)).toEqual(['plan:pl9', 'post:p1']);
    expect(() => removeRecents(null, ME, WS, cleared)).not.toThrow();
  });

  it('is scoped per user and workspace: a second account on this device sees none', () => {
    const s = memoryStorage();
    recordRecent(s, ME, WS, { type: 'plan', id: 'pl1' }, 1);
    expect(readRecents(s, ME, WS)).toHaveLength(1);
    expect(readRecents(s, OTHER, WS)).toEqual([]);
    expect(readRecents(s, ME, WS2)).toEqual([]);
  });

  it('sign-out clears every list; a user change keeps only the new user', () => {
    const s = memoryStorage();
    s.setItem('sorted-theme', 'dark');
    recordRecent(s, ME, WS, { type: 'plan', id: 'pl1' }, 1);
    recordRecent(s, OTHER, WS, { type: 'plan', id: 'pl2' }, 1);
    clearRecents(s, OTHER);
    expect(readRecents(s, ME, WS)).toEqual([]);
    expect(readRecents(s, OTHER, WS)).toHaveLength(1);
    clearRecents(s);
    expect(readRecents(s, OTHER, WS)).toEqual([]);
    expect(s.getItem('sorted-theme')).toBe('dark');
  });

  it('works with storage blocked or missing (never throws)', () => {
    const blocked = blockedStorage();
    expect(() => recordRecent(blocked, ME, WS, { type: 'post', id: 'p' }, 1)).not.toThrow();
    expect(readRecents(blocked, ME, WS)).toEqual([]);
    expect(() => clearRecents(blocked)).not.toThrow();
    expect(readRecents(null, ME, WS)).toEqual([]);
    expect(() => recordRecent(null, ME, WS, { type: 'post', id: 'p' }, 1)).not.toThrow();
  });

  it('ignores corrupt or foreign data', () => {
    const s = memoryStorage();
    s.setItem(recentKey(ME, WS), 'not json');
    expect(readRecents(s, ME, WS)).toEqual([]);
    s.setItem(recentKey(ME, WS), JSON.stringify([{ type: 'secret', id: 'x', openedAt: 1 }, 7]));
    expect(readRecents(s, ME, WS)).toEqual([]);
  });
});

describe('recentFromRoute', () => {
  const ctx = { workspaceId: WS, workspaceKey: 'GBL', userId: ME };
  it('maps every opened route to its item', () => {
    expect(recentFromRoute('/posts/p1', '', ctx)).toEqual({ type: 'post', id: 'p1' });
    expect(recentFromRoute('/briefs/b1', '', ctx)).toEqual({ type: 'brief', id: 'b1' });
    expect(recentFromRoute('/p/gbl-12', '', ctx)).toEqual({ type: 'post', number: 12 });
    expect(recentFromRoute('/b/gbl-3', '', ctx)).toEqual({ type: 'brief', number: 3 });
    expect(recentFromRoute('/p/abc-3', '', ctx)).toBeNull();
    expect(recentFromRoute('/plans/pl1', '?item=i1', ctx)).toEqual({ type: 'plan', id: 'pl1' });
    expect(recentFromRoute('/assets', '?asset=a1', ctx)).toEqual({ type: 'file', id: 'a1' });
    expect(recentFromRoute('/assets', '', ctx)).toBeNull();
    expect(recentFromRoute('/chat', `?channel=group__${WS}__g1`, ctx)).toEqual({
      type: 'group',
      id: 'g1',
    });
    expect(recentFromRoute('/chat', `?channel=dm__${WS}__${ME}__${PEER}`, ctx)).toEqual({
      type: 'person',
      id: PEER,
    });
    expect(recentFromRoute('/chat', `?channel=notes__${WS}__${ME}`, ctx)).toEqual({
      type: 'person',
      id: ME,
    });
    expect(recentFromRoute('/chat', `?channel=group__${WS}__g1&task=t1`, ctx)).toEqual({
      type: 'task',
      id: 't1',
    });
    expect(recentFromRoute('/chat', `?channel=group__${WS2}__g1`, ctx)).toBeNull();
    expect(recentFromRoute('/pipeline', '', ctx)).toBeNull();
  });

  it('records a short link once its number resolves (one ref_resolve rpc on the key)', async () => {
    const s = memoryStorage();
    const rpc = vi.fn(async () => ({
      data: [{ workspace_id: WS, entity_id: 'p-uuid' }],
      error: null,
    }));
    const from = vi.fn();
    const client = { rpc, from } as unknown as Client;
    await recordRouteOpen({
      client,
      storage: s,
      pathname: '/p/gbl-12',
      search: '',
      workspaceId: WS,
      workspaceKey: 'gbl',
      userId: ME,
      nowMs: 5,
      traceId: '01920000-0000-7000-8000-0000000000aa',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ref_resolve', {
      p_trace_id: '01920000-0000-7000-8000-0000000000aa',
      p_workspace_key: 'GBL',
      p_kind: 'post',
      p_number: 12,
    });
    expect(from).not.toHaveBeenCalled();
    expect(readRecents(s, ME, WS)).toEqual([{ type: 'post', id: 'p-uuid', openedAt: 5 }]);
  });

  it('a brief short link asks for the brief kind', async () => {
    const s = memoryStorage();
    const rpc = vi.fn(async () => ({
      data: [{ workspace_id: WS, entity_id: 'b-uuid' }],
      error: null,
    }));
    await recordRouteOpen({
      client: { rpc } as unknown as Client,
      storage: s,
      pathname: '/b/gbl-3',
      search: '',
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
      nowMs: 6,
    });
    expect(rpc).toHaveBeenCalledWith('ref_resolve', expect.objectContaining({ p_kind: 'brief' }));
    expect(readRecents(s, ME, WS)).toEqual([{ type: 'brief', id: 'b-uuid', openedAt: 6 }]);
  });

  it('a number that resolves to no entity, or an rpc error, records nothing', async () => {
    const s = memoryStorage();
    const base = {
      storage: s,
      pathname: '/p/gbl-12',
      search: '',
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
      nowMs: 7,
    };
    const missing = vi.fn(async () => ({
      data: [{ workspace_id: WS, entity_id: null }],
      error: null,
    }));
    await recordRouteOpen({ ...base, client: { rpc: missing } as unknown as Client });
    const failed = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    await recordRouteOpen({ ...base, client: { rpc: failed } as unknown as Client });
    expect(readRecents(s, ME, WS)).toEqual([]);
  });
});

describe('loadRecentEntries', () => {
  /** A fake PostgREST: each table's rows, filtered by the .in('id') list; records calls. */
  function fakeClient(tables: Record<string, Array<Record<string, unknown>>>) {
    const calls: Array<{ table: string; ids: string[] }> = [];
    const from = vi.fn((table: string) => {
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
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data: (tables[table] ?? []).filter((r) => ids.includes(String(r.id ?? r.user_id))),
            error: null,
          }),
      };
      return chain;
    });
    return { client: { from } as unknown as Client, calls };
  }

  const items: RecentItem[] = [
    { type: 'post', id: 'p1', openedAt: 9 },
    { type: 'group', id: 'g1', openedAt: 8 },
    { type: 'post', id: 'p-deleted', openedAt: 7 },
    { type: 'post', id: 'p2', openedAt: 6 },
    { type: 'person', id: PEER, openedAt: 5 },
    { type: 'person', id: ME, openedAt: 4 },
    { type: 'task', id: 't1', openedAt: 3 },
    { type: 'file', id: 'a1', openedAt: 2 },
    { type: 'plan', id: 'never-shown', openedAt: 1 },
  ];

  it('one batched .in() read per type, no N+1; drops what is not returned', async () => {
    const { client, calls } = fakeClient({
      posts: [
        { id: 'p1', title: 'Monday carousel', number: 1 },
        { id: 'p2', title: '', number: 2 },
      ],
      groups: [{ id: 'g1', name: 'Launch crew' }],
      users: [
        { id: PEER, display_name: 'Priya Raman', username: 'priya', avatar_url: null },
        { id: ME, display_name: 'Sam Okafor', username: 'sam', avatar_url: null },
      ],
      workspace_members: [{ user_id: PEER }],
      chat_tasks: [{ id: 't1', title: 'Cut the teaser', channel_id: 'group__w__g1' }],
      assets: [{ id: 'a1', display_name: null, filename: 'brief.pdf' }],
    });
    const entries = await loadRecentEntries({
      client,
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
      items,
    });
    // At most one call per table; the 9th item (beyond the 8 shown) is never read.
    const tables = calls.map((c) => c.table);
    expect(new Set(tables).size).toBe(tables.length);
    expect(tables).not.toContain('plans');
    expect(calls.find((c) => c.table === 'posts')?.ids).toEqual(['p1', 'p-deleted', 'p2']);
    expect(entries.map((e) => [e.type, e.title])).toEqual([
      ['post', 'Monday carousel'],
      ['group', 'Launch crew'],
      ['post', 'Untitled post'],
      ['person', 'Priya Raman'],
      ['person', 'Sam Okafor'],
      ['task', 'Cut the teaser'],
      ['file', 'brief.pdf'],
    ]);
    expect(entries.length).toBeLessThanOrEqual(RECENT_SHOWN);
    expect(entries.find((e) => e.type === 'group')?.target).toEqual({
      path: `/chat?channel=group__${WS}__g1`,
    });
    expect(entries.find((e) => e.id === PEER)?.target).toEqual({ person: PEER });
  });

  it('an untitled post or brief reads "Untitled post" / "Untitled brief", never a KEY-N code', async () => {
    const { client } = fakeClient({
      posts: [{ id: 'p9', title: '   ', number: 9 }],
      briefs: [
        { id: 'b4', title: '', number: 4 },
        { id: 'b5', title: 'Diwali brief', number: 5 },
      ],
    });
    const entries = await loadRecentEntries({
      client,
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
      items: [
        { type: 'post', id: 'p9', openedAt: 3 },
        { type: 'brief', id: 'b4', openedAt: 2 },
        { type: 'brief', id: 'b5', openedAt: 1 },
      ],
    });
    expect(entries.map((e) => [e.type, e.title])).toEqual([
      ['post', 'Untitled post'],
      ['brief', 'Untitled brief'],
      ['brief', 'Diwali brief'],
    ]);
    for (const e of entries) expect(e.title).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
    // The link still uses the short /p and /b path.
    expect(entries[0]?.target).toEqual({ path: '/p/gbl-9' });
    expect(entries[1]?.target).toEqual({ path: '/b/gbl-4' });
  });

  it('a person who left drops; a failed read drops that type silently', async () => {
    const { client } = fakeClient({
      users: [{ id: PEER, display_name: 'Priya Raman', avatar_url: null }],
      workspace_members: [],
    });
    const entries = await loadRecentEntries({
      client,
      workspaceId: WS,
      workspaceKey: null,
      userId: ME,
      items: [
        { type: 'person', id: PEER, openedAt: 2 },
        { type: 'brief', id: 'b-gone', openedAt: 1 },
      ],
    });
    expect(entries).toEqual([]);
  });
});

/** A fake PostgREST that records every .in() read; rows by table. */
function recordingClient(tables: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ table: string; ids: string[] }> = [];
  const from = vi.fn((table: string) => {
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
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data: (tables[table] ?? []).filter((r) => ids.includes(String(r.id))),
          error: null,
        }),
    };
    return chain;
  });
  return { client: { from } as unknown as Client, calls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('title warm-up', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches several records into one read per type, debounced, and caches the titles', async () => {
    const s = memoryStorage();
    const { client, calls } = recordingClient({
      posts: [
        { id: 'p1', title: 'Monday carousel', number: 1 },
        { id: 'p2', title: 'Tuesday reel', number: 2 },
      ],
      groups: [{ id: 'g1', name: 'Launch crew' }],
    });
    const warmer = createTitleWarmer({
      client,
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
      storage: () => s,
      idle: (run) => {
        run();
        return () => {};
      },
    });
    recordRecent(s, ME, WS, { type: 'post', id: 'p1' }, 1);
    warmer.schedule();
    vi.advanceTimersByTime(WARM_DEBOUNCE_MS - 100);
    recordRecent(s, ME, WS, { type: 'group', id: 'g1' }, 2);
    warmer.schedule();
    recordRecent(s, ME, WS, { type: 'post', id: 'p2' }, 3);
    warmer.schedule();
    vi.advanceTimersByTime(WARM_DEBOUNCE_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(calls.map((c) => c.table).sort()).toEqual(['groups', 'posts']);
    expect(calls.find((c) => c.table === 'posts')?.ids.sort()).toEqual(['p1', 'p2']);
    expect(readRecents(s, ME, WS).map((i) => i.title)).toEqual([
      'Tuesday reel',
      'Launch crew',
      'Monday carousel',
    ]);
    // Everything is cached: a later schedule reads nothing.
    warmer.schedule();
    vi.advanceTimersByTime(WARM_DEBOUNCE_MS);
    await flush();
    expect(calls).toHaveLength(2);
    warmer.dispose();
  });
});

describe('session refresh', () => {
  beforeEach(() => resetRecentsRefresh());

  it('runs once per session, updates titles, drops what is not returned', async () => {
    const s = memoryStorage();
    s.setItem(
      recentKey(ME, WS),
      JSON.stringify([
        { type: 'post', id: 'p1', openedAt: 3, title: 'Old title', target: { path: '/p/gbl-1' } },
        { type: 'post', id: 'p-gone', openedAt: 2, title: 'Gone', target: { path: '/p/gbl-2' } },
        { type: 'group', id: 'g1', openedAt: 1, title: 'Crew', target: { path: '/chat' } },
      ]),
    );
    const snapshot = readRecents(s, ME, WS);
    const { client, calls } = recordingClient({
      posts: [{ id: 'p1', title: 'New title', number: 1 }],
      groups: [{ id: 'g1', name: 'Launch crew' }],
    });
    const params = { client, storage: s, workspaceId: WS, workspaceKey: 'GBL', userId: ME };
    expect(recentsRefreshed(ME, WS)).toBe(false);
    await refreshRecentTitles(params);
    expect(calls.map((c) => c.table).sort()).toEqual(['groups', 'posts']);
    expect(readRecents(s, ME, WS).map((i) => [i.id, i.title])).toEqual([
      ['p1', 'New title'],
      ['g1', 'Launch crew'],
    ]);
    // Rows already drawn come from the open's snapshot: the refresh never touches them.
    expect(cachedEntries(snapshot).map((e) => e.title)).toEqual(['Old title', 'Gone', 'Crew']);
    expect(recentsRefreshed(ME, WS)).toBe(true);
    await refreshRecentTitles(params);
    expect(calls).toHaveLength(2);
  });

  it('a failed read drops nothing of that type; an aborted pass runs again next time', async () => {
    const s = memoryStorage();
    s.setItem(
      recentKey(ME, WS),
      JSON.stringify([
        { type: 'post', id: 'p1', openedAt: 1, title: 'Kept', target: { path: '/p/gbl-1' } },
      ]),
    );
    const from = vi.fn(() => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'x' } }),
      };
      return chain;
    });
    const base = {
      client: { from } as unknown as Client,
      storage: s,
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
    };
    await refreshRecentTitles(base);
    expect(readRecents(s, ME, WS)).toHaveLength(1);
    resetRecentsRefresh();
    const controller = new AbortController();
    controller.abort();
    await refreshRecentTitles({ ...base, signal: controller.signal });
    expect(recentsRefreshed(ME, WS)).toBe(false);
    expect(readRecents(s, ME, WS)).toHaveLength(1);
  });
});
