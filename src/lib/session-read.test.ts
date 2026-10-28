// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dropWorkspaceReads,
  hydrateSessionReads,
  hydratedUserId,
  invalidateReads,
  noteAuthUser,
  retainWorkspaceReads,
  peekKept,
  peekRead,
  primeRead,
  READ_FRESH_MS,
  readKey,
  resetSessionReads,
  sharedRead,
} from '@/lib/session-read';
import { SIGNOUT_EVENT, WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';
import {
  appVersion,
  flushDeviceCache,
  setDeviceCacheBackend,
  type CacheBackend,
  type CacheRecord,
} from '@/lib/device-cache';

afterEach(() => {
  resetSessionReads();
  vi.useRealTimers();
});

describe('sharedRead', () => {
  it('joins one in-flight read for concurrent callers', async () => {
    const load = vi.fn(() => Promise.resolve(1));
    const key = readKey('u', 'w', 'x');
    const [a, b] = await Promise.all([sharedRead(key, load), sharedRead(key, load)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves a settled read inside the window without a new request', async () => {
    const load = vi.fn(() => Promise.resolve('rows'));
    await sharedRead('k', load);
    await sharedRead('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(peekRead('k')).toBe('rows');
  });

  it('treats a read older than the window as absent (stale guard)', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    await sharedRead('k', load);
    vi.advanceTimersByTime(READ_FRESH_MS + 1);
    expect(peekRead('k')).toBeUndefined();
    await expect(sharedRead('k', load)).resolves.toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(2);
    await expect(sharedRead('k', load)).rejects.toThrow('x');
    await expect(sharedRead('k', load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops a value isOk rejects', async () => {
    const load = vi.fn(() => Promise.resolve({ ok: false }));
    await sharedRead('k', load, { isOk: (v) => v.ok });
    expect(peekRead('k')).toBeUndefined();
    await sharedRead('k', load, { isOk: (v) => v.ok });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a read that left before signout never lands after it', async () => {
    let resolve: (v: number) => void = () => {};
    const pending = sharedRead('k', () => new Promise<number>((r) => (resolve = r)));
    window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    resolve(5);
    await pending;
    expect(peekRead('k')).toBeUndefined();
  });

  it('marks stale by prefix and on workspace-data-changed, keeping the value', () => {
    primeRead(readKey('u', 'w', 'a'), 1);
    primeRead(readKey('u', 'v', 'a'), 2);
    invalidateReads(readKey('u', 'w', ''));
    expect(peekRead(readKey('u', 'w', 'a'))).toBeUndefined();
    expect(peekKept(readKey('u', 'w', 'a'))).toBe(1);
    expect(peekRead(readKey('u', 'v', 'a'))).toBe(2);
    window.dispatchEvent(new CustomEvent(WORKSPACE_DATA_CHANGED_EVENT));
    expect(peekRead(readKey('u', 'v', 'a'))).toBeUndefined();
    expect(peekKept(readKey('u', 'v', 'a'))).toBe(2);
  });

  it('a stale key reads again on the next sharedRead', async () => {
    const load = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    await sharedRead('k', load);
    invalidateReads('k');
    expect(peekKept('k')).toBe('old');
    await expect(sharedRead('k', load)).resolves.toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
    expect(peekKept('k')).toBe('new');
  });
});

describe('peekKept', () => {
  it('keeps a value past the freshness window', async () => {
    vi.useFakeTimers();
    await sharedRead('k', () => Promise.resolve('rows'));
    vi.advanceTimersByTime(READ_FRESH_MS * 10);
    expect(peekRead('k')).toBeUndefined();
    expect(peekKept('k')).toBe('rows');
  });

  it('keeps the old value while a newer read runs, then takes the new one', async () => {
    vi.useFakeTimers();
    await sharedRead('k', () => Promise.resolve('old'));
    vi.advanceTimersByTime(READ_FRESH_MS + 1);
    let resolve: (v: string) => void = () => {};
    const next = sharedRead('k', () => new Promise<string>((r) => (resolve = r)));
    expect(peekKept('k')).toBe('old');
    resolve('new');
    await next;
    expect(peekKept('k')).toBe('new');
  });

  it('keeps the old value when the newer read fails or is not ok', async () => {
    primeRead('k', { ok: true });
    invalidateReads('k');
    await expect(sharedRead('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(peekKept('k')).toEqual({ ok: true });
    await sharedRead('k', () => Promise.resolve({ ok: false }), { isOk: (v) => v.ok });
    expect(peekKept('k')).toEqual({ ok: true });
  });

  it('a primed write updates the kept value', () => {
    primeRead('k', 'read');
    primeRead('k', 'written');
    expect(peekKept('k')).toBe('written');
  });

  it('signout clears every kept value', () => {
    primeRead(readKey('u', 'w', 'a'), 1);
    window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    expect(peekKept(readKey('u', 'w', 'a'))).toBeUndefined();
  });

  it('dropWorkspaceReads deletes only that workspace for that user', () => {
    primeRead(readKey('u', 'w', 'a'), 1);
    primeRead(readKey('u', 'w2', 'a'), 2);
    primeRead(readKey('x', 'w', 'a'), 3);
    dropWorkspaceReads('u', 'w');
    expect(peekKept(readKey('u', 'w', 'a'))).toBeUndefined();
    expect(peekKept(readKey('u', 'w2', 'a'))).toBe(2);
    expect(peekKept(readKey('x', 'w', 'a'))).toBe(3);
  });
});

/** An in-memory stand-in for IndexedDB. */
function memoryBackend(): CacheBackend & { rows: Map<string, CacheRecord> } {
  const rows = new Map<string, CacheRecord>();
  return {
    rows,
    getAll: async () => [...rows.values()],
    putMany: async (records) => {
      for (const r of records) rows.set(r.key, r);
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

function saved(key: string, value: unknown): CacheRecord {
  const [userId = '', workspaceId = ''] = key.split(':');
  return {
    key,
    value,
    savedAt: Date.now(),
    userId,
    workspaceId: workspaceId === '' ? null : workspaceId,
    appVersion: appVersion(),
    size: 1,
  };
}

describe('device cache', () => {
  let mem: ReturnType<typeof memoryBackend>;
  const key = readKey('u', 'w', 'posts');

  beforeEach(() => {
    mem = memoryBackend();
    setDeviceCacheBackend(mem);
  });

  afterEach(() => {
    setDeviceCacheBackend(null);
  });

  it('hydrated values are kept but stale: peekKept paints them, the first sharedRead reads', async () => {
    mem.rows.set(key, saved(key, ['row']));
    await hydrateSessionReads('u');
    expect(hydratedUserId()).toBe('u');
    expect(peekKept(key)).toEqual(['row']);
    expect(peekRead(key)).toBeUndefined();
    const load = vi.fn(() => Promise.resolve(['fresh']));
    await expect(sharedRead(key, load)).resolves.toEqual(['fresh']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(peekKept(key)).toEqual(['fresh']);
  });

  it('a read still running with no value takes the saved value as kept; the read lands over it', async () => {
    mem.rows.set(key, saved(key, ['saved']));
    let answer: (value: string[]) => void = () => undefined;
    const running = sharedRead(
      key,
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve;
        }),
    );
    expect(peekKept(key)).toBeUndefined();
    await hydrateSessionReads('u');
    expect(peekKept(key)).toEqual(['saved']);
    answer(['fresh']);
    await expect(running).resolves.toEqual(['fresh']);
    expect(peekKept(key)).toEqual(['fresh']);
  });

  it('never overwrites a value this tab already holds', async () => {
    mem.rows.set(key, saved(key, 'saved'));
    primeRead(key, 'live');
    await hydrateSessionReads('u');
    expect(peekKept(key)).toBe('live');
  });

  it('an ok settle and a primed write are saved; a failure is not', async () => {
    await sharedRead(key, () => Promise.resolve('read'));
    primeRead(readKey('u', 'w', 'view:chip'), 'all');
    await sharedRead(readKey('u', 'w', 'bad'), () => Promise.resolve({ ok: false }), {
      isOk: (v) => v.ok,
    });
    await flushDeviceCache();
    expect(mem.rows.get(key)?.value).toBe('read');
    expect(mem.rows.get(readKey('u', 'w', 'view:chip'))?.value).toBe('all');
    expect(mem.rows.has(readKey('u', 'w', 'bad'))).toBe(false);
  });

  it('invalidateReads keeps the saved value', async () => {
    primeRead(key, 'v');
    await flushDeviceCache();
    invalidateReads('');
    await flushDeviceCache();
    expect(mem.rows.get(key)?.value).toBe('v');
  });

  it('signout wipes the device copy', async () => {
    primeRead(key, 'v');
    await flushDeviceCache();
    window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    await flushDeviceCache();
    expect(mem.rows.size).toBe(0);
  });

  it('a SIGNED_OUT auth event wipes (sign-out paths without SIGNOUT_EVENT)', async () => {
    primeRead(key, 'v');
    await flushDeviceCache();
    noteAuthUser('SIGNED_OUT', null);
    await flushDeviceCache();
    expect(peekKept(key)).toBeUndefined();
    expect(mem.rows.size).toBe(0);
  });

  it('a sign-in as a different user wipes before anything is seeded', async () => {
    mem.rows.set(key, saved(key, 'u-row'));
    await hydrateSessionReads('u');
    noteAuthUser('SIGNED_IN', 'u');
    expect(peekKept(key)).toBe('u-row');
    noteAuthUser('SIGNED_IN', 'other');
    await flushDeviceCache();
    expect(peekKept(key)).toBeUndefined();
    expect(mem.rows.size).toBe(0);
  });

  it('workspace loss drops that workspace here and on the device', async () => {
    primeRead(readKey('u', 'w', 'a'), 1);
    primeRead(readKey('u', 'w2', 'a'), 2);
    primeRead(readKey('u', '', 'shell:workspaces'), []);
    await flushDeviceCache();
    retainWorkspaceReads('u', ['w2']);
    await flushDeviceCache();
    expect(peekKept(readKey('u', 'w', 'a'))).toBeUndefined();
    expect(peekKept(readKey('u', 'w2', 'a'))).toBe(2);
    expect([...mem.rows.keys()].sort()).toEqual([
      readKey('u', '', 'shell:workspaces'),
      readKey('u', 'w2', 'a'),
    ]);
  });
});
