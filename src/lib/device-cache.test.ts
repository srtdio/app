// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn, error: vi.fn(), info: vi.fn() } }));

import {
  drop,
  flushDeviceCache,
  hydrate,
  isPersistable,
  MAX_STORE_BYTES,
  MAX_VALUE_BYTES,
  overCapKeys,
  parseKey,
  put,
  savedWorkspaceIds,
  setDeviceCacheBackend,
  storedSessionUserId,
  wipe,
  type CacheBackend,
  type CacheRecord,
} from '@/lib/device-cache';

/** An in-memory stand-in for IndexedDB. */
function memoryBackend(): CacheBackend & { rows: Map<string, CacheRecord> } {
  const rows = new Map<string, CacheRecord>();
  return {
    rows,
    getAll: async () => [...rows.values()].map((r) => ({ ...r })),
    putMany: async (records) => {
      for (const r of records) rows.set(r.key, { ...r });
    },
    deleteKeys: async (keys) => {
      for (const k of keys) rows.delete(k);
    },
    deletePrefix: async (prefix) => {
      for (const k of [...rows.keys()]) if (k.startsWith(prefix)) rows.delete(k);
    },
    clear: async () => rows.clear(),
  };
}

function record(key: string, over: Partial<CacheRecord> = {}): CacheRecord {
  const parsed = parseKey(key);
  return {
    key,
    value: { v: key },
    savedAt: 1_000_000,
    userId: parsed?.userId ?? 'u1',
    workspaceId: parsed?.workspaceId ?? null,
    appVersion: 'v1',
    size: 10,
    ...over,
  };
}

const NOW = 1_000_000 + 60_000;
let mem: ReturnType<typeof memoryBackend>;

beforeEach(() => {
  mem = memoryBackend();
  setDeviceCacheBackend(mem);
  warn.mockClear();
});

afterEach(() => {
  setDeviceCacheBackend(null);
});

describe('keys', () => {
  it('parses user and workspace, with an empty workspace as user-level', () => {
    expect(parseKey('u1:w1:posts')).toEqual({ userId: 'u1', workspaceId: 'w1' });
    expect(parseKey('u1::shell:profile')).toEqual({ userId: 'u1', workspaceId: null });
    expect(parseKey('k')).toBeNull();
  });

  it('saves the chat list and pages, never the open reads or keys without a user', () => {
    expect(isPersistable('u1:w1:chat-open:members')).toBe(false);
    expect(isPersistable('u1:w1:chat:list')).toBe(true);
    expect(isPersistable('u1:w1:chat:page:c1')).toBe(true);
    expect(isPersistable('u1:w1:chat:pages')).toBe(true);
    expect(isPersistable('k')).toBe(false);
    expect(isPersistable('u1:w1:pipeline-posts')).toBe(true);
  });
});

describe('hydrate', () => {
  it('returns only this user, same-version records', async () => {
    mem.rows.set('u1:w1:a', record('u1:w1:a'));
    mem.rows.set('u2:w1:a', record('u2:w1:a'));
    const out = await hydrate('u1', { version: 'v1' });
    expect([...out.keys()]).toEqual(['u1:w1:a']);
    expect(out.get('u1:w1:a')).toEqual({ v: 'u1:w1:a' });
    await flushDeviceCache();
    // The other user's records are deleted.
    expect([...mem.rows.keys()]).toEqual(['u1:w1:a']);
  });

  it('has no age limit: a record saved long ago (or dated ahead) is still returned', async () => {
    const year = 365 * 24 * 60 * 60 * 1000;
    mem.rows.set('u1:w1:old', record('u1:w1:old', { savedAt: NOW - year }));
    mem.rows.set('u1:w1:ahead', record('u1:w1:ahead', { savedAt: NOW + year }));
    mem.rows.set('u1:w1:chat:list', record('u1:w1:chat:list', { savedAt: 0 }));
    const out = await hydrate('u1', { version: 'v1' });
    expect([...out.keys()].sort()).toEqual(['u1:w1:ahead', 'u1:w1:chat:list', 'u1:w1:old']);
    await flushDeviceCache();
    expect(mem.rows.size).toBe(3);
  });

  it('wipes everything on a version mismatch', async () => {
    mem.rows.set('u1:w1:a', record('u1:w1:a'));
    mem.rows.set('u1:w1:b', record('u1:w1:b', { appVersion: 'v0' }));
    const out = await hydrate('u1', { version: 'v1' });
    expect(out.size).toBe(0);
    expect(mem.rows.size).toBe(0);
  });

  it('returns nothing when a wipe lands while it reads', async () => {
    mem.rows.set('u1:w1:a', record('u1:w1:a'));
    const pending = hydrate('u1', { version: 'v1' });
    void wipe();
    expect((await pending).size).toBe(0);
  });
});

describe('failures are a silent no-op', () => {
  it('a failing backend hydrates empty, never throws, and logs once', async () => {
    const broken: CacheBackend = {
      getAll: () => Promise.reject(new Error('blocked')),
      putMany: () => Promise.reject(new Error('quota')),
      deleteKeys: () => Promise.reject(new Error('x')),
      deletePrefix: () => Promise.reject(new Error('x')),
      clear: () => Promise.reject(new Error('x')),
    };
    setDeviceCacheBackend(broken);
    await expect(hydrate('u1')).resolves.toEqual(new Map());
    put('u1:w1:a', 1);
    put('u1:w1:b', 2);
    await expect(flushDeviceCache()).resolves.toBeUndefined();
    put('u1:w1:c', 3);
    await expect(flushDeviceCache()).resolves.toBeUndefined();
    await expect(drop('u1:w1:')).resolves.toBeUndefined();
    await expect(wipe()).resolves.toBeUndefined();
    const writeWarnings = warn.mock.calls.filter(
      (call) => (call[1] as { reason?: string }).reason === 'write failed',
    );
    expect(writeWarnings).toHaveLength(1);
  });

  it('with no IndexedDB at all (private mode, old browser) it does nothing and logs nothing', async () => {
    setDeviceCacheBackend(null);
    await expect(hydrate('u1')).resolves.toEqual(new Map());
    put('u1:w1:a', 1);
    await expect(flushDeviceCache()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('batches puts off the paint path and keeps the last write per key', async () => {
    vi.useFakeTimers();
    try {
      put('u1:w1:a', 1, NOW);
      put('u1:w1:a', 2, NOW);
      expect(mem.rows.size).toBe(0);
      await flushDeviceCache();
      expect(mem.rows.get('u1:w1:a')).toMatchObject({
        value: 2,
        userId: 'u1',
        workspaceId: 'w1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a value over 2 MB and logs once', async () => {
    put('u1:w1:big', 'x'.repeat(MAX_VALUE_BYTES + 1));
    put('u1:w1:small', 'ok');
    await flushDeviceCache();
    expect(mem.rows.has('u1:w1:big')).toBe(false);
    expect(mem.rows.has('u1:w1:small')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('holds the store at 100 MB', () => {
    expect(MAX_STORE_BYTES).toBe(100 * 1024 * 1024);
    const entries = new Map([
      ['a', { savedAt: 1, size: 60 * 1024 * 1024 }],
      ['b', { savedAt: 2, size: 39 * 1024 * 1024 }],
    ]);
    expect(overCapKeys(entries)).toEqual([]);
    entries.set('c', { savedAt: 3, size: 2 * 1024 * 1024 });
    expect(overCapKeys(entries)).toEqual(['a']);
  });

  it('caps the store by dropping the oldest records', () => {
    const entries = new Map([
      ['a', { savedAt: 1, size: 40 }],
      ['b', { savedAt: 3, size: 40 }],
      ['c', { savedAt: 2, size: 40 }],
    ]);
    expect(overCapKeys(entries, 100)).toEqual(['a']);
    expect(overCapKeys(entries, 200)).toEqual([]);
  });

  it('drops by prefix, stored and queued', async () => {
    put('u1:w1:a', 1);
    put('u1:w2:a', 2);
    await flushDeviceCache();
    put('u1:w1:b', 3);
    await drop('u1:w1:');
    await flushDeviceCache();
    expect([...mem.rows.keys()]).toEqual(['u1:w2:a']);
    expect(savedWorkspaceIds('u1')).toEqual(['w2']);
  });

  it('wipe deletes everything and a queued write never lands after it', async () => {
    put('u1:w1:a', 1);
    await flushDeviceCache();
    put('u1:w1:b', 2);
    await wipe();
    await flushDeviceCache();
    expect(mem.rows.size).toBe(0);
  });
});

describe('storedSessionUserId', () => {
  it('reads the user id from the supabase-js session key', () => {
    localStorage.setItem('sb-proj-auth-token', JSON.stringify({ user: { id: 'u9' } }));
    expect(storedSessionUserId()).toBe('u9');
    localStorage.setItem('sb-proj-auth-token', 'not json');
    expect(storedSessionUserId()).toBeNull();
    localStorage.clear();
    expect(storedSessionUserId()).toBeNull();
  });
});
