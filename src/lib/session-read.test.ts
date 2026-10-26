// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dropWorkspaceReads,
  invalidateReads,
  peekKept,
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
