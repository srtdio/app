import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  clearRecents,
  loadRecentEntries,
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
  it('stores only {type, id, openedAt}, newest first, de-duplicated, max 20', () => {
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

  it('records a short link once its number resolves (one read)', async () => {
    const s = memoryStorage();
    const maybeSingle = vi.fn(async () => ({ data: { id: 'p-uuid' }, error: null }));
    const chain = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle };
    const client = { from: vi.fn(() => chain) } as unknown as Client;
    await recordRouteOpen({
      client,
      storage: s,
      pathname: '/p/gbl-12',
      search: '',
      workspaceId: WS,
      workspaceKey: 'GBL',
      userId: ME,
      nowMs: 5,
    });
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    expect(readRecents(s, ME, WS)).toEqual([{ type: 'post', id: 'p-uuid', openedAt: 5 }]);
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
