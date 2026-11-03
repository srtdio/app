// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_ALERT_PREFS,
  pauseFor,
  setAlertPrefsUser,
  writeAlertPrefs,
} from '@/lib/alert-prefs';
import {
  CHIME_GAP_MS,
  CHIME_REPEATS,
  createChime,
  type ChimeAudioContext,
  type GestureTarget,
} from '@/lib/chat/chime';

function fakeAudio() {
  const oscillators: { started: number }[] = [];
  const ctx: ChimeAudioContext = {
    currentTime: 0,
    state: 'running',
    destination: {},
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createOscillator() {
      const o = { started: 0 };
      oscillators.push(o);
      return {
        type: 'sine',
        frequency: { setValueAtTime: () => undefined },
        connect: () => undefined,
        start: () => {
          o.started += 1;
        },
        stop: () => undefined,
        disconnect: () => undefined,
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
        disconnect: () => undefined,
      };
    },
  };
  return { ctx, oscillators };
}

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  const target: GestureTarget = {
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
  };
  return {
    target,
    fire: (type: 'pointerdown' | 'keydown') => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

function timers() {
  const queue: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  let seq = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      queue.push({ fn, ms, id: seq, live: true });
      return seq;
    },
    clearTimer: (h: unknown) => {
      const t = queue.find((q) => q.id === h);
      if (t) t.live = false;
    },
    runUntil: (ms: number) => {
      for (const t of queue) {
        if (t.live && t.ms <= ms) {
          t.live = false;
          t.fn();
        }
      }
    },
  };
}

const HOUR = 3_600_000;
const USER = 'chime-user';

function unlockedChime() {
  const audio = fakeAudio();
  const g = fakeTarget();
  const t = timers();
  const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
  g.fire('pointerdown');
  return { audio, g, t, chime };
}

beforeEach(() => {
  localStorage.clear();
  writeAlertPrefs(USER, DEFAULT_ALERT_PREFS);
  setAlertPrefsUser(USER);
});

afterEach(() => {
  setAlertPrefsUser(null);
  vi.useRealTimers();
});

describe('the reminder chime obeys the alert prefs', () => {
  it('plays with the defaults', () => {
    const { audio, t, chime } = unlockedChime();
    chime.play();
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(CHIME_REPEATS * 2);
    chime.dispose();
  });

  it('is silent with Sound off, and nothing waits', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, sound: false });
    const { audio, t, chime } = unlockedChime();
    chime.play();
    expect(chime.active()).toBe(false);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(0);
    chime.dispose();
  });

  it('is silent with Notifications off', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, notifications: false });
    const { audio, t, chime } = unlockedChime();
    chime.play(1);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(0);
    chime.dispose();
  });

  it('a muted chime asked before the gesture never plays on the later tap', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, sound: false });
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
    chime.play();
    writeAlertPrefs(USER, DEFAULT_ALERT_PREFS);
    g.fire('pointerdown');
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(0);
    chime.dispose();
  });

  it('a pause set mid-chime silences the remaining repeats', () => {
    const { audio, t, chime } = unlockedChime();
    chime.play();
    t.runUntil(0);
    expect(audio.oscillators.length).toBe(2);
    writeAlertPrefs(USER, pauseFor(DEFAULT_ALERT_PREFS, 1, Date.now()));
    t.runUntil((CHIME_REPEATS - 1) * CHIME_GAP_MS);
    expect(audio.oscillators.length).toBe(2);
    chime.dispose();
  });

  it('is silent while paused and plays again once the pause ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000_000);
    writeAlertPrefs(USER, pauseFor(DEFAULT_ALERT_PREFS, 2, Date.now()));
    const { audio, t, chime } = unlockedChime();
    chime.play(1);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(0);
    // The same chime plays again once the pause has run out (no reload).
    vi.setSystemTime(50_000_000 + 2 * HOUR);
    chime.play(1);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(2);
    chime.dispose();
  });

  it('an injected gate overrides the prefs (no storage needed)', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    let ok = false;
    const chime = createChime({
      createContext: () => audio.ctx,
      target: g.target,
      allowed: () => ok,
      ...t,
    });
    g.fire('pointerdown');
    chime.play(1);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(0);
    ok = true;
    chime.play(1);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(2);
    chime.dispose();
  });
});
