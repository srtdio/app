import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSED_POLL_MS,
  createCockpitPoller,
  OPEN_POLL_MS,
  type PollerDeps,
} from '@/lib/cockpit/poll';
import { getCockpitState, resetCockpitState } from '@/lib/cockpit/store';
import type { CockpitFull, CockpitStatus, CockpitTab } from '@/lib/cockpit/types';

const STATUS: CockpitStatus = { checked_at: '2026-10-27T10:00:00Z', level: 'amber', alerts: [] };

function full(tab: CockpitTab): CockpitFull {
  return {
    ...STATUS,
    level: 'red',
    tab,
    tiles: {} as CockpitFull['tiles'],
    data: null,
  } as CockpitFull;
}

function setup() {
  let visible = true;
  let visibilityListener: () => void = () => undefined;
  let idle: () => void = () => undefined;
  const fetchStatus = vi.fn(() => Promise.resolve(STATUS));
  const fetchFull = vi.fn((tab: CockpitTab) => Promise.resolve(full(tab)));
  const deps: PollerDeps = {
    fetchStatus,
    fetchFull,
    isVisible: () => visible,
    onVisibilityChange: (l) => {
      visibilityListener = l;
      return () => undefined;
    },
    whenIdle: (run) => {
      idle = run;
      return () => undefined;
    },
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const poller = createCockpitPoller(deps);
  return {
    poller,
    fetchStatus,
    fetchFull,
    goIdle: () => idle(),
    setVisible: (v: boolean) => {
      visible = v;
      visibilityListener();
    },
  };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetCockpitState();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cockpit poller', () => {
  it('fetches nothing until the app is idle after first paint, then one status', async () => {
    const t = setup();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.fetchStatus).not.toHaveBeenCalled();
    expect(getCockpitState().level).toBe('grey');
    t.goIdle();
    await flush();
    expect(t.fetchStatus).toHaveBeenCalledTimes(1);
    expect(getCockpitState().level).toBe('amber');
  });

  it('closed: one status fetch every 60 s while visible', async () => {
    const t = setup();
    t.poller.start();
    t.goIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(CLOSED_POLL_MS - 1);
    expect(t.fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetchStatus).toHaveBeenCalledTimes(2);
    expect(t.fetchFull).not.toHaveBeenCalled();
  });

  it('never polls in a hidden tab, and resumes on show', async () => {
    const t = setup();
    t.poller.start();
    t.goIdle();
    await flush();
    t.setVisible(false);
    await vi.advanceTimersByTimeAsync(CLOSED_POLL_MS * 5);
    expect(t.fetchStatus).toHaveBeenCalledTimes(1);
    t.setVisible(true);
    await flush();
    expect(t.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('open: one full fetch marked open, then a poll every 30 s', async () => {
    const t = setup();
    t.poller.start();
    t.poller.open();
    await flush();
    expect(t.fetchFull).toHaveBeenLastCalledWith('needs', true);
    await vi.advanceTimersByTimeAsync(OPEN_POLL_MS);
    expect(t.fetchFull).toHaveBeenCalledTimes(2);
    expect(t.fetchFull).toHaveBeenLastCalledWith('needs', false);
    expect(t.fetchStatus).not.toHaveBeenCalled();
    expect(getCockpitState().latest?.tab).toBe('needs');
  });

  it('a tab pick fetches that tab marked open; reopening returns to it', async () => {
    const t = setup();
    t.poller.start();
    t.poller.open();
    await flush();
    t.poller.selectTab('users');
    await flush();
    expect(t.fetchFull).toHaveBeenLastCalledWith('users', true);
    t.poller.close();
    expect(getCockpitState().open).toBe(false);
    t.poller.open();
    await flush();
    expect(t.fetchFull).toHaveBeenLastCalledWith('users', true);
  });

  it('closing goes back to the 60 s status clock', async () => {
    const t = setup();
    t.poller.start();
    t.poller.open();
    await flush();
    t.poller.close();
    await vi.advanceTimersByTimeAsync(CLOSED_POLL_MS);
    expect(t.fetchStatus).toHaveBeenCalledTimes(1);
    expect(t.fetchFull).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch keeps the last answer', async () => {
    const t = setup();
    t.poller.start();
    t.goIdle();
    await flush();
    t.fetchStatus.mockRejectedValueOnce(new Error('down'));
    await vi.advanceTimersByTimeAsync(CLOSED_POLL_MS);
    expect(getCockpitState().level).toBe('amber');
  });
});
