// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_ALERT_PREFS,
  pauseFor,
  resumeAlerts,
  setAlertPrefsUser,
  writeAlertPrefs,
} from '@/lib/alert-prefs';
import {
  TONE_THROTTLE_MS,
  playToneShared,
  resetSharedTone,
  type ToneContext,
} from '@/lib/chat/notify-sound';

function fakeContext(): { ctx: ToneContext; starts: () => number } {
  let started = 0;
  const param = {
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
  };
  const ctx: ToneContext = {
    currentTime: 0,
    destination: {},
    createOscillator: () => ({
      type: 'sine',
      frequency: { setValueAtTime: () => undefined },
      connect: () => undefined,
      start: () => {
        started += 1;
      },
      stop: () => undefined,
    }),
    createGain: () => ({ gain: param, connect: () => undefined }),
  };
  return { ctx, starts: () => started };
}

const HOUR = 3_600_000;
const USER = 'tone-user';

beforeEach(() => {
  localStorage.clear();
  resetSharedTone();
  writeAlertPrefs(USER, DEFAULT_ALERT_PREFS);
  setAlertPrefsUser(USER);
});

afterEach(() => {
  setAlertPrefsUser(null);
  vi.useRealTimers();
});

describe('playToneShared obeys the alert prefs', () => {
  it('plays with the defaults', () => {
    const { ctx, starts } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(true);
    expect(starts()).toBe(2);
  });

  it('is silent with Sound off', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, sound: false });
    const { ctx, starts } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(false);
    expect(starts()).toBe(0);
  });

  it('is silent with Notifications off', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, notifications: false });
    const { ctx, starts } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(false);
    expect(starts()).toBe(0);
  });

  it('is silent while paused and plays again once the pause ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    writeAlertPrefs(USER, pauseFor(DEFAULT_ALERT_PREFS, 1, Date.now()));
    const { ctx, starts } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(false);
    vi.setSystemTime(10_000_000 + HOUR - 1);
    expect(playToneShared(1_000 + TONE_THROTTLE_MS, ctx)).toBe(false);
    expect(starts()).toBe(0);
    vi.setSystemTime(10_000_000 + HOUR);
    expect(playToneShared(1_000 + 2 * TONE_THROTTLE_MS, ctx)).toBe(true);
    expect(starts()).toBe(2);
  });

  it('a muted tone does not consume the shared throttle', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, sound: false });
    const { ctx } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(false);
    writeAlertPrefs(USER, resumeAlerts({ ...DEFAULT_ALERT_PREFS, sound: true }));
    expect(playToneShared(1_001, ctx)).toBe(true);
  });

  it('obeys a pause another tab set (read at the moment of play)', () => {
    const { ctx } = fakeContext();
    localStorage.setItem(
      `sorted:alert-prefs:v1:${USER}`,
      JSON.stringify({ ...DEFAULT_ALERT_PREFS, sound: false }),
    );
    expect(playToneShared(1_000, ctx)).toBe(false);
  });

  it('signed out: the previous user mute does not carry over', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, sound: false });
    setAlertPrefsUser(null);
    const { ctx } = fakeContext();
    expect(playToneShared(1_000, ctx)).toBe(true);
  });
});
