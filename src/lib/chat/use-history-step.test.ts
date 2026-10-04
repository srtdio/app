import { beforeEach, describe, expect, it, vi } from 'vitest';

// ChatConnected's import graph pulls the agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
import { leaveSelectionThen } from '@/lib/chat/forward';
import {
  buriedStepCount,
  enterHistoryStep,
  hasPreviousEntry,
  HISTORY_STEP_KEYS,
  isBuriedStep,
  resetHistorySteps,
  stepMarkerOf,
  type HistoryStepWindow,
} from '@/lib/chat/use-history-step';
import {
  channelWriteFor,
  chatBackAction,
  closesOnParamLoss,
  type ChannelWrite,
} from '@/components/chat/ChatConnected';

// A browser-like history stack whose traversals queue: back() only enqueues,
// flush() runs them in order, firing popstate after each. push/replace stand
// in for React Router's own writes (state { idx }).
function queuedWindow(urls: string[]): HistoryStepWindow & {
  url: () => string;
  index: () => number;
  flush: () => void;
  write: (to: string, mode: ChannelWrite) => void;
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
    write: (to, mode) => {
      if (mode === 'replace') {
        stack[i] = { state: { idx: i }, url: to };
        return;
      }
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
const ACTIVITY = 'https://v2.srtd.io/activity';
const LIST = 'https://v2.srtd.io/chat';
const CHAT_A = 'https://v2.srtd.io/chat?channel=a';
const CHAT_B = 'https://v2.srtd.io/chat?channel=b';

beforeEach(() => {
  resetHistorySteps();
});

describe('N1/N2: every open is one step, every back pops one', () => {
  it('Pipeline -> Chat tab -> open chat: back = the list, back again = Pipeline', () => {
    const win = queuedWindow([PIPELINE]);
    win.write(LIST, 'push');
    win.write(CHAT_A, channelWriteFor('open'));
    win.history.back();
    win.flush();
    expect(win.url()).toBe(LIST);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(PIPELINE);
  });

  it('the incoming-message toast leaves exactly one step: /chat push, then the pending open replaces it', () => {
    const win = queuedWindow([PIPELINE]);
    win.write(LIST, 'push');
    win.write(CHAT_B, channelWriteFor('pendingOpen'));
    expect(win.index()).toBe(1);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(PIPELINE);
  });

  it('Activity -> mention: back = Activity', () => {
    const win = queuedWindow([ACTIVITY]);
    win.write(`${CHAT_A}&message=m1`, 'push');
    // The ?message= strip replaces: no step added or removed.
    win.write(CHAT_A, channelWriteFor('unknown'));
    win.history.back();
    win.flush();
    expect(win.url()).toBe(ACTIVITY);
  });

  it('opens push; pending opens, auto-closes, cold backs and unknown links replace', () => {
    expect(channelWriteFor('open')).toBe('push');
    expect(channelWriteFor('pendingOpen')).toBe('replace');
    expect(channelWriteFor('autoClose')).toBe('replace');
    expect(channelWriteFor('coldBack')).toBe('replace');
    expect(channelWriteFor('unknown')).toBe('replace');
  });
});

describe('N5/N6: the header arrow', () => {
  it('pops when an in-app entry sits below, else goes to the list in place', () => {
    expect(chatBackAction({ idx: 2 })).toBe('pop');
    expect(chatBackAction({ idx: 2, chatSelection: 5 })).toBe('pop');
    expect(chatBackAction({ idx: 0 })).toBe('list');
    expect(chatBackAction(null)).toBe('list');
    expect(chatBackAction(undefined)).toBe('list');
    expect(hasPreviousEntry({ idx: '1' })).toBe(false);
  });

  it('a cold open (/chat?channel=X first) replaces itself with the list', () => {
    const win = queuedWindow([CHAT_A]);
    expect(chatBackAction(win.history.state)).toBe('list');
    win.write(LIST, channelWriteFor('coldBack'));
    expect(win.index()).toBe(0);
    expect(win.url()).toBe(LIST);
  });
});

describe('N7: laptop', () => {
  it('a param loss closes the chat on every layout; a switch does not', () => {
    expect(closesOnParamLoss('a', null)).toBe(true);
    expect(closesOnParamLoss('a', 'b')).toBe(false);
    expect(closesOnParamLoss(null, null)).toBe(false);
    expect(closesOnParamLoss(null, 'a')).toBe(false);
  });

  it('chat A -> chat B pushes; back = A, back again = the screen before Chat', () => {
    const win = queuedWindow([PIPELINE, LIST]);
    win.write(CHAT_A, 'push');
    win.write(CHAT_B, 'push');
    win.history.back();
    win.flush();
    expect(win.url()).toBe(CHAT_A);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(LIST);
  });

  it('a switch with a layer open pops the layer first, then pushes the next chat', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const onExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.contact, onExit);
    expect(win.index()).toBe(2);
    leaveSelectionThen(() => win.write(CHAT_B, 'push'));
    win.flush();
    expect(onExit).toHaveBeenCalledOnce();
    expect(win.url()).toBe(CHAT_B);
    win.history.back();
    win.flush();
    // Chat A, its own entry (never the layer's).
    expect(win.url()).toBe(CHAT_A);
    expect(stepMarkerOf(win.history.state, HISTORY_STEP_KEYS.contact)).toBeNull();
  });
});

describe('N4: a layer is one step', () => {
  it('opening pushes one entry at the same URL; back closes only the layer and stays in the chat', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const onExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.threadView, onExit);
    expect(win.index()).toBe(2);
    expect(win.url()).toBe(CHAT_A);
    expect(win.history.state).toMatchObject({
      idx: 1,
      [HISTORY_STEP_KEYS.threadView]: expect.any(Number),
    });
    win.history.back();
    win.flush();
    expect(onExit).toHaveBeenCalledOnce();
    expect(win.url()).toBe(CHAT_A);
    expect(win.listeners()).toBe(0);
  });

  it.each(Object.values(HISTORY_STEP_KEYS))(
    '%s: its own close pops its step, so the next back leaves the chat',
    (key) => {
      const win = queuedWindow([LIST, CHAT_A]);
      const onExit = vi.fn();
      enterHistoryStep(win, key, onExit).dispose();
      win.flush();
      expect(win.index()).toBe(1);
      expect(onExit).not.toHaveBeenCalled();
      expect(win.listeners()).toBe(0);
      win.history.back();
      win.flush();
      expect(win.url()).toBe(LIST);
    },
  );

  it('nested with selection: back leaves selection first, then the layer, then the chat', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const order: string[] = [];
    enterHistoryStep(win, HISTORY_STEP_KEYS.threadView, () => order.push('thread'));
    enterHistoryStep(win, 'chatSelection', () => order.push('selection'));
    // Each entry carries one marker only.
    expect(stepMarkerOf(win.history.state, HISTORY_STEP_KEYS.threadView)).toBeNull();
    win.history.back();
    win.flush();
    expect(order).toEqual(['selection']);
    win.history.back();
    win.flush();
    expect(order).toEqual(['selection', 'thread']);
    expect(win.url()).toBe(CHAT_A);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(LIST);
  });

  it('a layer closed while another opens: the new push waits for the pop to land', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const contact = enterHistoryStep(win, HISTORY_STEP_KEYS.contact, vi.fn());
    contact.dispose();
    const starredExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.starred, starredExit);
    // Not pushed yet: the pop is still queued.
    expect(win.index()).toBe(2);
    win.flush();
    expect(win.index()).toBe(2);
    expect(stepMarkerOf(win.history.state, HISTORY_STEP_KEYS.starred)).not.toBeNull();
    expect(starredExit).not.toHaveBeenCalled();
    win.history.back();
    win.flush();
    expect(starredExit).toHaveBeenCalledOnce();
    expect(win.url()).toBe(CHAT_A);
    expect(win.index()).toBe(1);
  });

  it('an open right after a layer closed waits for the pop (no push undone by it)', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    enterHistoryStep(win, HISTORY_STEP_KEYS.newChat, vi.fn()).dispose();
    leaveSelectionThen(() => win.write(CHAT_B, 'push'));
    expect(win.url()).not.toBe(CHAT_B);
    win.flush();
    expect(win.url()).toBe(CHAT_B);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(CHAT_A);
  });

  it('a layer left under a navigation is buried and skipped on the way back', () => {
    const win = queuedWindow([LIST, CHAT_A]);
    const step = enterHistoryStep(win, HISTORY_STEP_KEYS.marks, vi.fn());
    win.write(PIPELINE, 'push');
    step.dispose();
    expect(buriedStepCount()).toBe(1);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(CHAT_A);
    expect(isBuriedStep(win.history.state)).toBe(false);
    resetHistorySteps();
    expect(win.listeners()).toBe(0);
  });
});

describe('N8: a chat closing on its own replaces', () => {
  it('group info open, then left: the sheet pops, the chat entry becomes the list', () => {
    const win = queuedWindow([PIPELINE, CHAT_A]);
    const onExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.groupInfo, onExit);
    leaveSelectionThen(() => win.write(LIST, channelWriteFor('autoClose')));
    win.flush();
    expect(onExit).toHaveBeenCalledOnce();
    expect(win.url()).toBe(LIST);
    expect(win.index()).toBe(1);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(PIPELINE);
  });
});

describe('N3: the bell is part of history', () => {
  it('chat opened from a bell row: back = chat home with the bell open, back again closes it', () => {
    const win = queuedWindow([PIPELINE, LIST]);
    const bellExit = vi.fn();
    const bell = enterHistoryStep(win, HISTORY_STEP_KEYS.bell, bellExit);
    // A row: the bell keeps its entry and the chat pushes.
    bell.detach();
    win.write(CHAT_A, 'push');
    win.history.back();
    win.flush();
    // Landed on the kept entry: the bell adopts it (no second push).
    expect(stepMarkerOf(win.history.state, HISTORY_STEP_KEYS.bell)).not.toBeNull();
    expect(isBuriedStep(win.history.state)).toBe(false);
    const reopenedExit = vi.fn();
    enterHistoryStep(win, HISTORY_STEP_KEYS.bell, reopenedExit, { adopt: true });
    expect(win.index()).toBe(2);
    win.history.back();
    win.flush();
    expect(reopenedExit).toHaveBeenCalledOnce();
    expect(bellExit).not.toHaveBeenCalled();
    expect(win.url()).toBe(LIST);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(PIPELINE);
  });

  it('closing the bell itself pops its step', () => {
    const win = queuedWindow([LIST]);
    enterHistoryStep(win, HISTORY_STEP_KEYS.bell, vi.fn()).dispose();
    win.flush();
    expect(win.index()).toBe(0);
    expect(win.listeners()).toBe(0);
  });
});
