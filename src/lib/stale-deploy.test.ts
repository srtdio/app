import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import {
  RELOAD_PARAM,
  STALE_RELOAD_KEY,
  runStaleDeployGuard,
  type StaleDeployDeps,
  type StylesheetLink,
} from '@/lib/stale-deploy';

// Node environment, no jsdom: every browser touchpoint is injected via deps.

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const throwingStorage = (): never => {
  throw new Error('SecurityError');
};

function makeDeps(overrides: Partial<StaleDeployDeps> = {}): StaleDeployDeps & {
  reload: ReturnType<typeof vi.fn<(url: string) => void>>;
  replaceUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
} {
  const storage = memoryStorage();
  return {
    stylesheet: null,
    isDocumentComplete: () => true,
    readBgToken: () => '#f7f8f9',
    getHref: () => 'https://v2.srtd.io/pipeline?x=1#top',
    storage: () => storage,
    now: () => 1700000000000,
    ...overrides,
    reload: vi.fn<(url: string) => void>(),
    replaceUrl: vi.fn<(url: string) => void>(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runStaleDeployGuard', () => {
  it('does nothing on a styled load', async () => {
    const deps = makeDeps();
    await expect(runStaleDeployGuard(deps)).resolves.toBe(true);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.replaceUrl).not.toHaveBeenCalled();
  });

  it('reloads exactly once with a cache-busting param when --bg is missing', async () => {
    const storage = memoryStorage();
    const deps = makeDeps({ readBgToken: () => '', storage: () => storage });
    await expect(runStaleDeployGuard(deps)).resolves.toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    const url = new URL(deps.reload.mock.calls[0]![0]);
    expect(url.searchParams.get(RELOAD_PARAM)).toBe('1700000000000');
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.pathname).toBe('/pipeline');
    expect(url.hash).toBe('#top');
    expect(storage.getItem(STALE_RELOAD_KEY)).toBe('1');
  });

  it('does not reload again when the guard is already set', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const storage = memoryStorage();
    storage.setItem(STALE_RELOAD_KEY, '1');
    const deps = makeDeps({ readBgToken: () => '', storage: () => storage });
    await expect(runStaleDeployGuard(deps)).resolves.toBe(true);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never loops when storage throws: the _r param bounds it to one reload', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const first = makeDeps({ readBgToken: () => '', storage: throwingStorage });
    await expect(runStaleDeployGuard(first)).resolves.toBe(false);
    expect(first.reload).toHaveBeenCalledTimes(1);

    const reloadedHref = first.reload.mock.calls[0]![0];
    const second = makeDeps({
      readBgToken: () => '',
      storage: throwingStorage,
      getHref: () => reloadedHref,
    });
    await expect(runStaleDeployGuard(second)).resolves.toBe(true);
    expect(second.reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('removes the _r param and clears the guard after a styled load', async () => {
    const storage = memoryStorage();
    storage.setItem(STALE_RELOAD_KEY, '1');
    const deps = makeDeps({
      storage: () => storage,
      getHref: () => `https://v2.srtd.io/pipeline?x=1&${RELOAD_PARAM}=123#top`,
    });
    await expect(runStaleDeployGuard(deps)).resolves.toBe(true);
    expect(deps.replaceUrl).toHaveBeenCalledWith('https://v2.srtd.io/pipeline?x=1#top');
    expect(storage.getItem(STALE_RELOAD_KEY)).toBeNull();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('waits for the stylesheet load event before checking', async () => {
    let bg = '';
    const link: StylesheetLink = Object.assign(new EventTarget(), { sheet: null });
    const deps = makeDeps({
      stylesheet: link,
      isDocumentComplete: () => false,
      readBgToken: () => bg,
    });
    const result = runStaleDeployGuard(deps);
    bg = '#f7f8f9';
    link.dispatchEvent(new Event('load'));
    await expect(result).resolves.toBe(true);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('stops waiting after the timeout when no load or error event fires', async () => {
    vi.useFakeTimers();
    const link: StylesheetLink = Object.assign(new EventTarget(), { sheet: null });
    const deps = makeDeps({
      stylesheet: link,
      isDocumentComplete: () => false,
      readBgToken: () => '',
    });
    const result = runStaleDeployGuard(deps);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });
});
