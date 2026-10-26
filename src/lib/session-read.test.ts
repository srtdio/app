// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateReads,
  peekRead,
  primeRead,
  READ_FRESH_MS,
  readKey,
  resetSessionReads,
  sharedRead,
} from '@/lib/session-read';
import { SIGNOUT_EVENT, WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';

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

  it('invalidates by prefix and on workspace-data-changed', () => {
    primeRead(readKey('u', 'w', 'a'), 1);
    primeRead(readKey('u', 'v', 'a'), 2);
    invalidateReads(readKey('u', 'w', ''));
    expect(peekRead(readKey('u', 'w', 'a'))).toBeUndefined();
    expect(peekRead(readKey('u', 'v', 'a'))).toBe(2);
    window.dispatchEvent(new CustomEvent(WORKSPACE_DATA_CHANGED_EVENT));
    expect(peekRead(readKey('u', 'v', 'a'))).toBeUndefined();
  });
});
