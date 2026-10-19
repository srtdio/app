import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACK_GUARD_STEP_KEY, enterBackGuard } from '@/lib/back-guard';
import {
  buriedStepCount,
  enterHistoryStep,
  HISTORY_STEP_KEYS,
  isBuriedStep,
  resetHistorySteps,
  stepMarkerOf,
  type HistoryStepWindow,
} from '@/lib/chat/use-history-step';

// A browser-like history stack whose traversals queue: back() only enqueues,
// flush() runs them in order, firing popstate after each. write() stands in
// for React Router's own pushes (state { idx }).
function queuedWindow(urls: string[]): HistoryStepWindow & {
  url: () => string;
  index: () => number;
  flush: () => void;
  write: (to: string) => void;
  listeners: () => number;
} {
  const stack = urls.map((u, idx) => ({ state: { idx } as unknown, url: u }));
  let i = stack.length - 1;
  const queue: (() => void)[] = [];
  const listeners = new Set<() => void>();
  return {
    url: () => stack[i]?.url ?? '',
    index: () => i,
    listeners: () => listeners.size,
    flush: () => {
      while (queue.length > 0) queue.shift()?.();
    },
    write: (to) => {
      stack.splice(i + 1);
      stack.push({ state: { idx: i + 1 }, url: to });
      i += 1;
    },
    history: {
      get state() {
        return stack[i]?.state;
      },
      pushState: (data, _unused, next) => {
        stack.splice(i + 1);
        stack.push({ state: data, url: next ?? '' });
        i += 1;
      },
      back: () => {
        queue.push(() => {
          if (i === 0) return;
          i -= 1;
          for (const l of [...listeners]) l();
        });
      },
    },
    location: {
      get href() {
        return stack[i]?.url ?? '';
      },
    },
    addEventListener: (_type, l) => listeners.add(l),
    removeEventListener: (_type, l) => listeners.delete(l),
  };
}

const PIPELINE = 'https://v2.srtd.io/pipeline';
const LIST = 'https://v2.srtd.io/chat';
const CHAT_A = 'https://v2.srtd.io/chat?channel=a';

const guardMarker = (win: HistoryStepWindow): number | null =>
  stepMarkerOf(win.history.state, BACK_GUARD_STEP_KEY);

function back(win: ReturnType<typeof queuedWindow>): void {
  win.history.back();
  win.flush();
}

beforeEach(() => {
  resetHistorySteps();
});

describe.each([
  ['the New plan screen', HISTORY_STEP_KEYS.planCompose],
  ['the Tasks sheet', 'chatTasks'],
])('a guard above %s step', (_name, key) => {
  it('Back asks (onBack) and the layer stays: its step never reacts', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const closeLayer = vi.fn();
    enterHistoryStep(win, key, closeLayer);
    const onBack = vi.fn();
    enterBackGuard(win, onBack);
    expect(win.index()).toBe(3);
    back(win);
    expect(onBack).toHaveBeenCalledOnce();
    expect(closeLayer).not.toHaveBeenCalled();
    // The guard's entry is back on top, at the chat's URL.
    expect(win.index()).toBe(3);
    expect(win.url()).toBe(CHAT_A);
    expect(guardMarker(win)).not.toBeNull();
    expect(stepMarkerOf(win.history.state, key)).toBeNull();
  });

  it('Keep editing, then Back again: asks again, the layer still stays', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const closeLayer = vi.fn();
    enterHistoryStep(win, key, closeLayer);
    const onBack = vi.fn();
    enterBackGuard(win, onBack);
    back(win);
    // Keep editing: the caller closes its confirm and changes nothing else.
    back(win);
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(closeLayer).not.toHaveBeenCalled();
    expect(win.index()).toBe(3);
  });

  it('Discard (release, then the close) leaves history at the chat entry with no stray entry', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const layer = enterHistoryStep(win, key, vi.fn());
    const guard = enterBackGuard(win, vi.fn());
    back(win);
    // Discard: the guard is released, then the layer closes (its dispose).
    guard.dispose();
    layer.dispose();
    win.flush();
    expect(win.index()).toBe(1);
    expect(win.url()).toBe(CHAT_A);
    expect(guardMarker(win)).toBeNull();
    expect(stepMarkerOf(win.history.state, key)).toBeNull();
    expect(buriedStepCount()).toBe(0);
    expect(win.listeners()).toBe(0);
    // One Back now leaves the chat (never "press Back twice").
    back(win);
    expect(win.url()).toBe(LIST);
  });

  it('a programmatic close while guarded (Create succeeded) leaves no stray entry', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const layer = enterHistoryStep(win, key, vi.fn());
    const guard = enterBackGuard(win, vi.fn());
    expect(win.index()).toBe(3);
    // The screen unmounts: its guard's cleanup runs first (child), then the
    // layer's own step cleanup (parent), with no release in between.
    guard.dispose();
    layer.dispose();
    win.flush();
    expect(win.index()).toBe(1);
    expect(win.url()).toBe(CHAT_A);
    expect(isBuriedStep(win.history.state)).toBe(false);
    expect(buriedStepCount()).toBe(0);
    back(win);
    expect(win.url()).toBe(LIST);
  });

  it('a close where the layer disposes before its guard still ends at the chat entry', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const layer = enterHistoryStep(win, key, vi.fn());
    const guard = enterBackGuard(win, vi.fn());
    layer.dispose();
    guard.dispose();
    win.flush();
    expect(win.index()).toBe(1);
    expect(win.url()).toBe(CHAT_A);
    back(win);
    expect(win.url()).toBe(LIST);
  });

  it('a new layer opened right after Discard waits for the pops, then sits on the chat entry', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const layer = enterHistoryStep(win, key, vi.fn());
    const guard = enterBackGuard(win, vi.fn());
    guard.dispose();
    layer.dispose();
    const nextExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.contact, nextExit);
    win.flush();
    expect(win.index()).toBe(2);
    expect(stepMarkerOf(win.history.state, HISTORY_STEP_KEYS.contact)).not.toBeNull();
    back(win);
    expect(nextExit).toHaveBeenCalledOnce();
    expect(win.index()).toBe(1);
  });
});

describe('a guard over a chat history step keeps the chat layer', () => {
  it('Back with the guard up never closes the New chat layer under it', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const closeNewChat = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.newChat, closeNewChat);
    const onBack = vi.fn();
    const guard = enterBackGuard(win, onBack);
    back(win);
    back(win);
    expect(closeNewChat).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(2);
    // Released: the next Back closes the layer, exactly as without a guard.
    guard.dispose();
    win.flush();
    expect(win.index()).toBe(2);
    back(win);
    expect(closeNewChat).toHaveBeenCalledOnce();
    expect(win.url()).toBe(CHAT_A);
    expect(win.index()).toBe(1);
  });

  it('nested under selection: only the top open step reacts to each pop', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const order: string[] = [];
    enterHistoryStep(win, HISTORY_STEP_KEYS.threadView, () => order.push('thread'));
    const guard = enterBackGuard(win, () => order.push('guard'));
    enterHistoryStep(win, 'chatSelection', () => order.push('selection'));
    back(win);
    expect(order).toEqual(['selection']);
    back(win);
    expect(order).toEqual(['selection', 'guard']);
    guard.dispose();
    win.flush();
    back(win);
    expect(order).toEqual(['selection', 'guard', 'thread']);
    expect(win.url()).toBe(CHAT_A);
  });
});

describe('one kept entry adopted by two layers (the two bell providers)', () => {
  it('Back closes both adopters, so the layer that shows the sheet closes too', () => {
    const win = queuedWindow([PIPELINE, LIST]);
    const kept = enterHistoryStep(win, HISTORY_STEP_KEYS.bell, vi.fn());
    kept.detach();
    win.write(CHAT_A);
    back(win);
    expect(stepMarkerOf(win.history.state, HISTORY_STEP_KEYS.bell)).not.toBeNull();
    const primaryExit = vi.fn();
    const chatExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.bell, primaryExit, { adopt: true });
    enterHistoryStep(win, HISTORY_STEP_KEYS.bell, chatExit, { adopt: true });
    expect(win.index()).toBe(2);
    back(win);
    expect(primaryExit).toHaveBeenCalledOnce();
    expect(chatExit).toHaveBeenCalledOnce();
    expect(win.url()).toBe(LIST);
    expect(win.index()).toBe(1);
    expect(win.listeners()).toBe(0);
    back(win);
    expect(win.url()).toBe(PIPELINE);
  });
});

describe('a guard on a non-chat page (no step under it)', () => {
  it('blocks Back off the route and asks; release lets the next Back leave', () => {
    const win = queuedWindow([LIST, PIPELINE]);
    const onBack = vi.fn();
    const guard = enterBackGuard(win, onBack);
    expect(win.index()).toBe(2);
    back(win);
    expect(onBack).toHaveBeenCalledOnce();
    expect(win.url()).toBe(PIPELINE);
    expect(win.index()).toBe(2);
    expect(guardMarker(win)).not.toBeNull();
    guard.dispose();
    win.flush();
    expect(win.index()).toBe(1);
    expect(guardMarker(win)).toBeNull();
    back(win);
    expect(win.url()).toBe(LIST);
  });

  it('release is safe to call twice and after Back was already answered', () => {
    const win = queuedWindow([PIPELINE]);
    const guard = enterBackGuard(win, vi.fn());
    back(win);
    guard.dispose();
    guard.dispose();
    win.flush();
    expect(win.index()).toBe(0);
    expect(win.listeners()).toBe(0);
  });

  it('a programmatic chat switch (cancel) leaves the guard silently: no onBack', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const onBack = vi.fn();
    const guard = enterBackGuard(win, onBack);
    const then = vi.fn();
    guard.cancel(then);
    win.flush();
    expect(onBack).not.toHaveBeenCalled();
    expect(then).toHaveBeenCalledOnce();
    expect(win.index()).toBe(1);
  });
});
