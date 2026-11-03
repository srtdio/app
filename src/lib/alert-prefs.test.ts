// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_ALERT_PREFS,
  PAUSE_HOURS,
  alertPrefsKey,
  currentSoundAllowed,
  currentTabAlertAllowed,
  isPaused,
  parseAlertPrefs,
  pauseFor,
  readAlertPrefs,
  resumeAlerts,
  setAlertPrefsUser,
  soundAllowed,
  subscribeAlertPrefs,
  tabAlertAllowed,
  useAlertPrefs,
  writeAlertPrefs,
  type AlertPrefs,
} from '@/lib/alert-prefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
let seq = 0;
/** A fresh user per test: the module keeps per-key caches across tests. */
function freshUser(): string {
  seq += 1;
  return `user-${seq}-${Math.random().toString(36).slice(2)}`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  setAlertPrefsUser(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('parseAlertPrefs', () => {
  it('is the defaults for missing or unreadable JSON', () => {
    expect(parseAlertPrefs(null)).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs('')).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs('{not json')).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs('null')).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs('[true]')).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs('42')).toEqual(DEFAULT_ALERT_PREFS);
  });

  it('defaults are sound on, notifications on, not paused', () => {
    expect(DEFAULT_ALERT_PREFS).toEqual({
      sound: true,
      notifications: true,
      pausedUntilMs: null,
      pausedHours: null,
    });
    expect(PAUSE_HOURS).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('validates each field on its own', () => {
    expect(parseAlertPrefs(JSON.stringify({ sound: false, notifications: 'no' }))).toEqual({
      ...DEFAULT_ALERT_PREFS,
      sound: false,
    });
    expect(parseAlertPrefs(JSON.stringify({ sound: 1, notifications: false }))).toEqual({
      ...DEFAULT_ALERT_PREFS,
      notifications: false,
    });
  });

  it('keeps a valid pause', () => {
    const p = parseAlertPrefs(JSON.stringify({ pausedUntilMs: 5_000, pausedHours: 2 }));
    expect(p.pausedUntilMs).toBe(5_000);
    expect(p.pausedHours).toBe(2);
  });

  it('drops both pause fields when either is invalid', () => {
    const bad = [
      { pausedUntilMs: 5_000, pausedHours: 7 },
      { pausedUntilMs: 5_000, pausedHours: 0 },
      { pausedUntilMs: 5_000, pausedHours: 1.5 },
      { pausedUntilMs: 5_000, pausedHours: '2' },
      { pausedUntilMs: 5_000 },
      { pausedUntilMs: '5000', pausedHours: 2 },
      { pausedUntilMs: null, pausedHours: 2 },
      { pausedHours: 3 },
    ];
    for (const b of bad) {
      const p = parseAlertPrefs(JSON.stringify(b));
      expect(p.pausedUntilMs).toBeNull();
      expect(p.pausedHours).toBeNull();
    }
    // Infinity does not survive JSON; a huge finite number is still a number.
    const inf = parseAlertPrefs('{"pausedUntilMs":1e999,"pausedHours":2}');
    expect(inf.pausedUntilMs).toBeNull();
    expect(inf.pausedHours).toBeNull();
  });
});

describe('keys and isolation', () => {
  it('the key carries the user id', () => {
    expect(alertPrefsKey('abc')).toBe('sorted:alert-prefs:v1:abc');
  });

  it('two users on one device never share prefs', () => {
    const a = freshUser();
    const b = freshUser();
    writeAlertPrefs(a, { ...DEFAULT_ALERT_PREFS, sound: false });
    expect(readAlertPrefs(a).sound).toBe(false);
    expect(readAlertPrefs(b)).toEqual(DEFAULT_ALERT_PREFS);
  });

  it('a null user reads the defaults', () => {
    expect(readAlertPrefs(null)).toBe(DEFAULT_ALERT_PREFS);
  });

  it('round-trips through localStorage and is stable between changes', () => {
    const u = freshUser();
    const prefs: AlertPrefs = {
      sound: false,
      notifications: true,
      pausedUntilMs: 9,
      pausedHours: 3,
    };
    writeAlertPrefs(u, prefs);
    expect(JSON.parse(localStorage.getItem(alertPrefsKey(u)) ?? 'null')).toEqual(prefs);
    const first = readAlertPrefs(u);
    expect(first).toEqual(prefs);
    expect(readAlertPrefs(u)).toBe(first);
  });

  it('the global gates follow the signed-in user, and defaults when signed out', () => {
    const a = freshUser();
    writeAlertPrefs(a, { ...DEFAULT_ALERT_PREFS, notifications: false });
    setAlertPrefsUser(a);
    expect(currentSoundAllowed()).toBe(false);
    expect(currentTabAlertAllowed()).toBe(false);
    setAlertPrefsUser(freshUser());
    expect(currentSoundAllowed()).toBe(true);
    setAlertPrefsUser(null);
    expect(currentSoundAllowed()).toBe(true);
    expect(currentTabAlertAllowed()).toBe(true);
  });
});

describe('rules', () => {
  it('isPaused ends exactly at pausedUntilMs', () => {
    const p = pauseFor(DEFAULT_ALERT_PREFS, 1, 1_000);
    expect(isPaused(p, 1_000)).toBe(true);
    expect(isPaused(p, 1_000 + HOUR - 1)).toBe(true);
    expect(isPaused(p, 1_000 + HOUR)).toBe(false);
    expect(isPaused(DEFAULT_ALERT_PREFS, 0)).toBe(false);
  });

  it('soundAllowed and tabAlertAllowed truth table', () => {
    const now = 10_000;
    const paused = (p: AlertPrefs): AlertPrefs => pauseFor(p, 2, now - 1);
    const rows: [AlertPrefs, boolean, boolean][] = [
      [{ ...DEFAULT_ALERT_PREFS, sound: true, notifications: true }, true, true],
      [{ ...DEFAULT_ALERT_PREFS, sound: false, notifications: true }, false, true],
      [{ ...DEFAULT_ALERT_PREFS, sound: true, notifications: false }, false, false],
      [{ ...DEFAULT_ALERT_PREFS, sound: false, notifications: false }, false, false],
      [paused({ ...DEFAULT_ALERT_PREFS }), false, false],
      [paused({ ...DEFAULT_ALERT_PREFS, sound: false }), false, false],
    ];
    for (const [prefs, sound, tab] of rows) {
      expect(soundAllowed(prefs, now)).toBe(sound);
      expect(tabAlertAllowed(prefs, now)).toBe(tab);
    }
    // An expired pause allows again.
    const expired = pauseFor(DEFAULT_ALERT_PREFS, 1, 0);
    expect(soundAllowed(expired, HOUR)).toBe(true);
    expect(tabAlertAllowed(expired, HOUR)).toBe(true);
  });

  it('pauseFor sets both fields; resumeAlerts clears both and keeps the rest', () => {
    const base: AlertPrefs = { ...DEFAULT_ALERT_PREFS, sound: false };
    for (const h of PAUSE_HOURS) {
      const p = pauseFor(base, h, 500);
      expect(p).toEqual({
        sound: false,
        notifications: true,
        pausedUntilMs: 500 + h * HOUR,
        pausedHours: h,
      });
      expect(resumeAlerts(p)).toEqual(base);
    }
  });
});

describe('storage failures', () => {
  it('a throwing getItem reads the defaults', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readAlertPrefs(freshUser())).toEqual(DEFAULT_ALERT_PREFS);
  });

  it('a throwing setItem does not throw and still holds for this tab', () => {
    const u = freshUser();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeAlertPrefs(u, { ...DEFAULT_ALERT_PREFS, sound: false })).not.toThrow();
    expect(readAlertPrefs(u).sound).toBe(false);
  });

  it('both throwing: write and read never throw', () => {
    const u = freshUser();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeAlertPrefs(u, DEFAULT_ALERT_PREFS)).not.toThrow();
    expect(() => readAlertPrefs(u)).not.toThrow();
  });
});

describe('subscribeAlertPrefs', () => {
  it('fires on a same-tab write, another tab, and a user switch', () => {
    const u = freshUser();
    setAlertPrefsUser(u);
    const fn = vi.fn();
    const off = subscribeAlertPrefs(fn);
    writeAlertPrefs(u, { ...DEFAULT_ALERT_PREFS, sound: false });
    expect(fn).toHaveBeenCalledTimes(1);
    // Another user's write is not ours.
    writeAlertPrefs(freshUser(), DEFAULT_ALERT_PREFS);
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: alertPrefsKey(u) }));
    expect(fn).toHaveBeenCalledTimes(2);
    setAlertPrefsUser(freshUser());
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    setAlertPrefsUser(null);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

/** Mounts the hook; `result.current` is its latest value. */
function mountHook(userId: string | null): {
  result: { current: readonly [AlertPrefs, (next: AlertPrefs) => void] | null; renders: number };
  unmount: () => void;
} {
  const result: {
    current: readonly [AlertPrefs, (next: AlertPrefs) => void] | null;
    renders: number;
  } = { current: null, renders: 0 };
  function Probe(): null {
    result.current = useAlertPrefs(userId);
    result.renders += 1;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  return { result, unmount: () => act(() => root.unmount()) };
}

describe('useAlertPrefs', () => {
  it('reads synchronously on the first frame', () => {
    const u = freshUser();
    writeAlertPrefs(u, { ...DEFAULT_ALERT_PREFS, notifications: false });
    const { result, unmount } = mountHook(u);
    expect(result.current?.[0].notifications).toBe(false);
    unmount();
  });

  it('the setter writes and re-renders this tab', () => {
    const u = freshUser();
    const { result, unmount } = mountHook(u);
    expect(result.current?.[0]).toEqual(DEFAULT_ALERT_PREFS);
    act(() => result.current?.[1]({ ...DEFAULT_ALERT_PREFS, sound: false }));
    expect(result.current?.[0].sound).toBe(false);
    expect(readAlertPrefs(u).sound).toBe(false);
    unmount();
  });

  it('another tab writing the key updates the hook within one storage event', () => {
    const u = freshUser();
    const { result, unmount } = mountHook(u);
    expect(result.current?.[0].sound).toBe(true);
    // The other tab's write lands in shared storage, then the event arrives.
    localStorage.setItem(
      alertPrefsKey(u),
      JSON.stringify({ sound: false, notifications: true, pausedUntilMs: null, pausedHours: null }),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: alertPrefsKey(u) }));
    });
    expect(result.current?.[0].sound).toBe(false);
    unmount();
  });

  it('ignores another key', () => {
    const u = freshUser();
    const { result, unmount } = mountHook(u);
    const before = result.renders;
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    });
    expect(result.renders).toBe(before);
    unmount();
  });

  it('a null user reads defaults and the setter is a no-op', () => {
    const { result, unmount } = mountHook(null);
    expect(result.current?.[0]).toBe(DEFAULT_ALERT_PREFS);
    act(() => result.current?.[1]({ ...DEFAULT_ALERT_PREFS, sound: false }));
    expect(result.current?.[0]).toBe(DEFAULT_ALERT_PREFS);
    unmount();
  });

  it('re-renders once when a pause ends, so isPaused reads false', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const u = freshUser();
    writeAlertPrefs(u, pauseFor(DEFAULT_ALERT_PREFS, 1, Date.now()));
    const { result, unmount } = mountHook(u);
    const prefs = result.current?.[0];
    expect(prefs !== undefined && isPaused(prefs, Date.now())).toBe(true);
    const before = result.renders;
    act(() => {
      vi.advanceTimersByTime(HOUR - 1);
    });
    expect(result.renders).toBe(before);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.renders).toBe(before + 1);
    const after = result.current?.[0];
    expect(after !== undefined && isPaused(after, Date.now())).toBe(false);
    unmount();
  });

  it('clears the expiry timer on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const u = freshUser();
    writeAlertPrefs(u, pauseFor(DEFAULT_ALERT_PREFS, 2, Date.now()));
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { result, unmount } = mountHook(u);
    const before = result.renders;
    unmount();
    expect(clear).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3 * HOUR);
    });
    expect(result.renders).toBe(before);
  });
});
