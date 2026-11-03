// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_ALERT_PREFS,
  alertPrefsKey,
  pauseFor,
  setAlertPrefsUser,
  writeAlertPrefs,
} from '@/lib/alert-prefs';
import { tabTitle } from '@/lib/chat/notify-sound';
import { pushTabAlert, type TabAlert } from '@/lib/tab-alert';

const USER = 'tab-user';
const BASE = 'Sorted';
const comment: TabAlert = { kind: 'activity', text: 'Chitra commented on Diwali reel' };

let hidden = true;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

// Counts favicon dot attempts: drawing the dot starts by loading the icon.
let images = 0;
class FakeImage {
  complete = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    images += 1;
  }
}

/** Bring the tab forward (the controller clears) and back to the background. */
function resetController(): void {
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  hidden = true;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Image', FakeImage);
  localStorage.clear();
  writeAlertPrefs(USER, DEFAULT_ALERT_PREFS);
  setAlertPrefsUser(USER);
  resetController();
  document.title = BASE;
  images = 0;
});

afterEach(() => {
  resetController();
  setAlertPrefsUser(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tab alert obeys the alert prefs', () => {
  it('flashes and draws the dot with the defaults', () => {
    pushTabAlert(comment);
    expect(document.title).toBe(comment.text);
    expect(images).toBe(1);
    vi.advanceTimersByTime(1_400);
    expect(document.title).toBe('(1) Sorted');
  });

  it('no flash and no dot with Notifications off', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, notifications: false });
    pushTabAlert(comment);
    vi.advanceTimersByTime(5_000);
    expect(document.title).toBe(BASE);
    expect(images).toBe(0);
  });

  it('no flash and no dot while paused', () => {
    writeAlertPrefs(USER, pauseFor(DEFAULT_ALERT_PREFS, 3, Date.now()));
    pushTabAlert(comment);
    vi.advanceTimersByTime(5_000);
    expect(document.title).toBe(BASE);
    expect(images).toBe(0);
  });

  it('Sound off alone still flashes (only Notifications and Pause gate the tab)', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, sound: false });
    pushTabAlert(comment);
    expect(document.title).toBe(comment.text);
  });

  it('the plain "(N) " unread prefix is never gated', () => {
    writeAlertPrefs(USER, { ...DEFAULT_ALERT_PREFS, notifications: false });
    document.title = tabTitle(document.title, 3);
    pushTabAlert(comment);
    vi.advanceTimersByTime(5_000);
    expect(document.title).toBe('(3) Sorted');
  });

  it('a pause set in this tab mid-flash stops it at once and restores the title', () => {
    pushTabAlert(comment);
    expect(document.title).toBe(comment.text);
    writeAlertPrefs(USER, pauseFor(DEFAULT_ALERT_PREFS, 1, Date.now()));
    expect(document.title).toBe(BASE);
    vi.advanceTimersByTime(5_000);
    expect(document.title).toBe(BASE);
  });

  it('Notifications turned off in another tab stops the flash on its storage event', () => {
    pushTabAlert(comment);
    localStorage.setItem(
      alertPrefsKey(USER),
      JSON.stringify({ ...DEFAULT_ALERT_PREFS, notifications: false }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: alertPrefsKey(USER) }));
    expect(document.title).toBe(BASE);
  });

  it('flashes again after a pause ends', () => {
    writeAlertPrefs(USER, pauseFor(DEFAULT_ALERT_PREFS, 1, Date.now()));
    pushTabAlert(comment);
    expect(document.title).toBe(BASE);
    vi.advanceTimersByTime(3_600_000);
    pushTabAlert(comment);
    expect(document.title).toBe(comment.text);
  });
});
