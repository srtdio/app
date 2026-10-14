import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_STYLESHEET,
  HOME_STYLESHEET,
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
  warn: ReturnType<typeof vi.fn<StaleDeployDeps['warn']>>;
} {
  const storage = memoryStorage();
  return {
    stylesheet: null,
    isDocumentComplete: () => true,
    readToken: () => '#f7f8f9',
    getHref: () => 'https://v2.srtd.io/pipeline?x=1#top',
    storage: () => storage,
    now: () => 1700000000000,
    ...overrides,
    reload: vi.fn<(url: string) => void>(),
    replaceUrl: vi.fn<(url: string) => void>(),
    warn: vi.fn<StaleDeployDeps['warn']>(),
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
    const deps = makeDeps({ readToken: () => '', storage: () => storage });
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
    const storage = memoryStorage();
    storage.setItem(STALE_RELOAD_KEY, '1');
    const deps = makeDeps({ readToken: () => '', storage: () => storage });
    await expect(runStaleDeployGuard(deps)).resolves.toBe(true);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('never loops when storage throws: the _r param bounds it to one reload', async () => {
    const first = makeDeps({ readToken: () => '', storage: throwingStorage });
    await expect(runStaleDeployGuard(first)).resolves.toBe(false);
    expect(first.reload).toHaveBeenCalledTimes(1);

    const reloadedHref = first.reload.mock.calls[0]![0];
    const second = makeDeps({
      readToken: () => '',
      storage: throwingStorage,
      getHref: () => reloadedHref,
    });
    await expect(runStaleDeployGuard(second)).resolves.toBe(true);
    expect(second.reload).not.toHaveBeenCalled();
    expect(first.warn).not.toHaveBeenCalled();
    expect(second.warn).toHaveBeenCalledTimes(1);
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
      readToken: () => bg,
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
      readToken: () => '',
    });
    const result = runStaleDeployGuard(deps);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });
});

describe('stylesheet targets', () => {
  it('keeps the app guard on the --bg token from src/index.css', () => {
    expect(APP_STYLESHEET).toEqual({
      selector: 'link[rel="stylesheet"][href*="/assets/"]',
      token: '--bg',
    });
  });

  it('checks the homepage stylesheet by its own token', () => {
    expect(HOME_STYLESHEET.token).toBe('--srtd-home');
    expect(HOME_STYLESHEET.token).not.toBe(APP_STYLESHEET.token);
  });

  it.each([
    ['app', APP_STYLESHEET],
    ['home', HOME_STYLESHEET],
  ])('runs the same guard for the %s stylesheet', async (_name, target) => {
    const tokens: Record<string, string> = { [target.token]: '1' };
    const styled = makeDeps({ readToken: () => tokens[target.token] ?? '' });
    await expect(runStaleDeployGuard(styled)).resolves.toBe(true);
    expect(styled.reload).not.toHaveBeenCalled();

    const unstyled = makeDeps({ readToken: () => '' });
    await expect(runStaleDeployGuard(unstyled)).resolves.toBe(false);
    expect(unstyled.reload).toHaveBeenCalledTimes(1);
  });
});
