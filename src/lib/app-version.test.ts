import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION_RELOAD_KEY,
  CHECK_INTERVAL_MS,
  CHECK_THROTTLE_MS,
  createNavigateReloader,
  createVersionChecker,
  parseVersion,
  runningVersion,
  startVersionChecks,
  type NavigateReloadDeps,
} from '@/lib/app-version';

/** A checker on a fake clock; the deployed version is whatever `deployed` holds. */
function checker(current: string, deployed: () => string | null) {
  let now = 1_000_000;
  const fetchVersion = vi.fn(() => Promise.resolve(deployed()));
  const c = createVersionChecker({ current, fetchVersion, now: () => now });
  return {
    ...c,
    fetchVersion,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    storage: () => ({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    }),
  };
}

function reloader(overrides: Partial<NavigateReloadDeps> = {}) {
  const mem = memoryStorage();
  const assign = vi.fn<(url: string) => void>();
  const onRoute = createNavigateReloader({
    staleVersion: () => 'new',
    storage: mem.storage,
    guardActive: () => false,
    assign,
    ...overrides,
  });
  return { onRoute, assign, map: mem.map };
}

const route = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('runningVersion / parseVersion', () => {
  it('reads a set version and treats unset as off', () => {
    expect(runningVersion('abc123')).toBe('abc123');
    expect(runningVersion(undefined)).toBe('');
    expect(runningVersion('  ')).toBe('');
  });

  it('parses only a non-empty version string', () => {
    expect(parseVersion('{"version":"abc"}')).toBe('abc');
    expect(parseVersion('<!doctype html>')).toBeNull();
    expect(parseVersion('{"version":""}')).toBeNull();
    expect(parseVersion('{"version":7}')).toBeNull();
    expect(parseVersion('null')).toBeNull();
  });
});

describe('stale detection', () => {
  it('marks stale when the deployed version differs', async () => {
    const c = checker('old', () => 'new');
    expect(c.staleVersion()).toBeNull();
    await c.check();
    expect(c.staleVersion()).toBe('new');
  });

  it('stays current when the versions match', async () => {
    const c = checker('same', () => 'same');
    await c.check();
    expect(c.staleVersion()).toBeNull();
  });

  it('does nothing on a network error or bad JSON', async () => {
    let deployed: string | null = 'new';
    const c = checker('old', () => deployed);
    await c.check();
    deployed = null;
    c.advance(CHECK_THROTTLE_MS);
    await c.check();
    expect(c.staleVersion()).toBe('new');

    const failing = createVersionChecker({
      current: 'old',
      fetchVersion: () => Promise.reject(new Error('offline')),
      now: () => 0,
    });
    await failing.check();
    expect(failing.staleVersion()).toBeNull();
  });

  it('clears stale after a rollback to the running version', async () => {
    let deployed = 'new';
    const c = checker('old', () => deployed);
    await c.check();
    deployed = 'old';
    c.advance(CHECK_THROTTLE_MS);
    await c.check();
    expect(c.staleVersion()).toBeNull();
  });
});

describe('throttle', () => {
  it('reads at most once per CHECK_THROTTLE_MS', async () => {
    const c = checker('old', () => 'old');
    await c.check();
    await c.check();
    c.advance(CHECK_THROTTLE_MS - 1);
    await c.check();
    expect(c.fetchVersion).toHaveBeenCalledTimes(1);
    c.advance(1);
    await c.check();
    expect(c.fetchVersion).toHaveBeenCalledTimes(2);
  });
});

describe('triggers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks on visible, on focus and on the interval while visible', () => {
    vi.useFakeTimers();
    const win = new EventTarget();
    const doc = new EventTarget();
    let visible = true;
    const check = vi.fn(() => Promise.resolve());
    const stop = startVersionChecks(
      { check },
      {
        target: win,
        visibilityTarget: doc,
        isVisible: () => visible,
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
      },
    );
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(check).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);

    visible = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);

    stop();
    visible = true;
    win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });
});

describe('reload on navigate', () => {
  it('never reloads on the first render', () => {
    const r = reloader();
    expect(r.onRoute(route('/pipeline'))).toBe(false);
    expect(r.assign).not.toHaveBeenCalled();
  });

  it('does not reload on a re-render of the same URL', () => {
    const r = reloader();
    r.onRoute(route('/pipeline'));
    expect(r.onRoute(route('/pipeline'))).toBe(false);
    expect(r.assign).not.toHaveBeenCalled();
  });

  it('does not reload while current', () => {
    const r = reloader({ staleVersion: () => null });
    r.onRoute(route('/pipeline'));
    expect(r.onRoute(route('/chat'))).toBe(false);
    expect(r.assign).not.toHaveBeenCalled();
  });

  it('reloads on a route change when stale, keeping search and hash', () => {
    const r = reloader();
    r.onRoute(route('/pipeline'));
    expect(r.onRoute(route('/posts/p1', '?comment=c9&x=1', '#top'))).toBe(true);
    expect(r.assign).toHaveBeenCalledWith('/posts/p1?comment=c9&x=1#top');
    expect(r.map.get(APP_VERSION_RELOAD_KEY)).toBe('new');
  });

  it('reloads once per target version', () => {
    const mem = memoryStorage();
    const assign = vi.fn<(url: string) => void>();
    let target = 'v2';
    const deps: NavigateReloadDeps = {
      staleVersion: () => target,
      storage: mem.storage,
      guardActive: () => false,
      assign,
    };
    const first = createNavigateReloader(deps);
    first(route('/a'));
    first(route('/b'));
    expect(assign).toHaveBeenCalledTimes(1);

    // The reload landed on a build that is still behind v2: no second reload.
    const second = createNavigateReloader(deps);
    second(route('/b'));
    expect(second(route('/c'))).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);

    // A newer deploy is a new target: one more reload.
    target = 'v3';
    expect(second(route('/d'))).toBe(true);
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it('never reloads when storage throws', () => {
    const r = reloader({
      storage: () => {
        throw new Error('blocked');
      },
    });
    r.onRoute(route('/a'));
    expect(r.onRoute(route('/b'))).toBe(false);
    expect(r.assign).not.toHaveBeenCalled();
  });

  it('respects an active Back guard, then reloads on a later navigation', () => {
    let guarded = true;
    const r = reloader({ guardActive: () => guarded });
    r.onRoute(route('/a'));
    expect(r.onRoute(route('/b'))).toBe(false);
    expect(r.assign).not.toHaveBeenCalled();
    guarded = false;
    expect(r.onRoute(route('/c'))).toBe(true);
    expect(r.assign).toHaveBeenCalledWith('/c');
  });
});

describe('version unset', () => {
  it('turns the whole check off', async () => {
    const c = checker('', () => 'new');
    await c.check();
    expect(c.fetchVersion).not.toHaveBeenCalled();
    expect(c.staleVersion()).toBeNull();

    const r = reloader({ staleVersion: () => c.staleVersion() });
    r.onRoute(route('/a'));
    expect(r.onRoute(route('/b'))).toBe(false);
    expect(r.assign).not.toHaveBeenCalled();
  });
});
