import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_SWIPE_PEEK_KEY,
  ROW_ACTION_PX,
  ROW_PEEK_DELAY_MS,
  ROW_PEEK_HOLD_MS,
  ROW_PEEK_PX,
  ROW_PEEK_SLIDE_MS,
  createDelayedRemover,
  createRowSwipeController,
  flushOnLeave,
  lockAxis,
  markPeekSeen,
  openRowOnSettle,
  openRowOnStart,
  peekWanted,
  resetPeekLoadForTests,
  rowSwipeEnabled,
  rowSwipeOffset,
  rowSwipeSettlesOpen,
  runPlanPeek,
  type StorageRead,
} from '@/lib/chat/use-row-swipe';

describe('axis lock', () => {
  it('pending under 10px of travel', () => {
    expect(lockAxis(-6, 6, false)).toBe('pending');
    expect(lockAxis(-10, 0, false)).toBe('pending');
  });
  it('mostly horizontal and leftward: a swipe', () => {
    expect(lockAxis(-14, 3, false)).toBe('swipe');
    expect(lockAxis(-11, -10, false)).toBe('swipe');
  });
  it('mostly vertical: the list scrolls, never a swipe', () => {
    expect(lockAxis(-8, 14, false)).toBe('none');
    expect(lockAxis(-10, -10, false)).toBe('none');
    expect(lockAxis(2, -40, true)).toBe('none');
  });
  it('rightward: nothing on a closed row, a swipe (to close) on an open one', () => {
    expect(lockAxis(14, 2, false)).toBe('none');
    expect(lockAxis(14, 2, true)).toBe('swipe');
  });
});

describe('offset and rest', () => {
  it('follows 1:1, never past the action, never right of rest', () => {
    expect(rowSwipeOffset(0, -30)).toBe(-30);
    expect(rowSwipeOffset(0, -200)).toBe(-ROW_ACTION_PX);
    expect(rowSwipeOffset(0, 40)).toBe(0);
    expect(rowSwipeOffset(-ROW_ACTION_PX, 30)).toBe(-58);
  });
  it('past half the action stays open; otherwise springs back; no full swipe', () => {
    expect(rowSwipeSettlesOpen(-45)).toBe(true);
    expect(rowSwipeSettlesOpen(-44)).toBe(false);
    expect(rowSwipeSettlesOpen(-ROW_ACTION_PX)).toBe(true);
  });
});

describe('the row controller', () => {
  const make = (open = false, enabled = true) => {
    const events: string[] = [];
    const c = createRowSwipeController({
      isOpen: () => open,
      enabled: () => enabled,
      onStart: () => events.push('start'),
      onDrag: (o) => events.push(`drag:${o}`),
      onSettle: (o) => events.push(o ? 'open' : 'closed'),
    });
    return { c, events };
  };

  it('a leftward swipe past half opens; the trailing click is swallowed', () => {
    const { c, events } = make();
    c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    c.handlers.onPointerMove({ clientX: 186, clientY: 101 });
    c.handlers.onPointerMove({ clientX: 140, clientY: 102 });
    expect(c.swiping()).toBe(true);
    c.handlers.onPointerUp();
    expect(events).toEqual(['start', 'drag:-14', 'drag:-60', 'open']);
    expect(c.consumeClickSuppression()).toBe(true);
    expect(c.consumeClickSuppression()).toBe(false);
  });

  it('a short swipe springs back', () => {
    const { c, events } = make();
    c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    c.handlers.onPointerMove({ clientX: 170, clientY: 100 });
    c.handlers.onPointerUp();
    expect(events.at(-1)).toBe('closed');
  });

  it('a vertical move never swipes for the rest of the press', () => {
    const { c, events } = make();
    c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    c.handlers.onPointerMove({ clientX: 196, clientY: 130 });
    c.handlers.onPointerMove({ clientX: 100, clientY: 132 });
    c.handlers.onPointerUp();
    expect(events).toEqual([]);
    expect(c.consumeClickSuppression()).toBe(false);
  });

  it('a tap never moves the row', () => {
    const { c, events } = make();
    c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    c.handlers.onPointerMove({ clientX: 197, clientY: 102 });
    c.handlers.onPointerUp();
    expect(events).toEqual([]);
  });

  it('an open row swiped right closes', () => {
    const { c, events } = make(true);
    c.handlers.onPointerDown({ clientX: 100, clientY: 100 });
    c.handlers.onPointerMove({ clientX: 160, clientY: 100 });
    c.handlers.onPointerUp();
    expect(events).toEqual(['start', `drag:${-ROW_ACTION_PX + 60}`, 'closed']);
  });

  it('disabled (a drag is running, a client): nothing', () => {
    const { c, events } = make(false, false);
    c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    c.handlers.onPointerMove({ clientX: 100, clientY: 100 });
    c.handlers.onPointerUp();
    expect(events).toEqual([]);
  });

  it('a long-press cancel drops the press; pointercancel springs back', () => {
    const a = make();
    a.c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    a.c.cancel();
    a.c.handlers.onPointerMove({ clientX: 100, clientY: 100 });
    expect(a.events).toEqual([]);
    const b = make();
    b.c.handlers.onPointerDown({ clientX: 200, clientY: 100 });
    b.c.handlers.onPointerMove({ clientX: 100, clientY: 100 });
    b.c.handlers.onPointerCancel();
    expect(b.events.at(-1)).toBe('closed');
  });
});

describe('one open row', () => {
  it('opening another row closes the first; closing only closes its own', () => {
    expect(openRowOnSettle(null, 'a', true)).toBe('a');
    expect(openRowOnSettle('a', 'b', true)).toBe('b');
    expect(openRowOnSettle('a', 'a', false)).toBeNull();
    expect(openRowOnSettle('a', 'b', false)).toBe('a');
    expect(openRowOnStart('a', 'b')).toBeNull();
    expect(openRowOnStart('a', 'a')).toBe('a');
  });
  it('clients never swipe; a name-only row never swipes', () => {
    expect(rowSwipeEnabled('agency', false)).toBe(true);
    expect(rowSwipeEnabled('client', false)).toBe(false);
    expect(rowSwipeEnabled('unknown', false)).toBe(false);
    expect(rowSwipeEnabled('agency', true)).toBe(false);
  });
});

describe('remove with Undo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (ok = true) => {
    const sent: string[] = [];
    const failed: string[] = [];
    const landed: string[] = [];
    const r = createDelayedRemover({
      delayMs: 5000,
      send: async (id) => {
        sent.push(id);
        return ok;
      },
      onSent: (id) => landed.push(id),
      onFailed: (id) => failed.push(id),
    });
    return { r, sent, failed, landed };
  };

  it('sends only when the toast expires', async () => {
    const { r, sent, landed } = make();
    r.schedule('a');
    await vi.advanceTimersByTimeAsync(4999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['a']);
    expect(landed).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(['a']);
  });

  it('Undo cancels: no request ever', async () => {
    const { r, sent } = make();
    r.schedule('a');
    expect(r.undo()).toBe(true);
    expect(r.undo()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    r.flush();
    expect(sent).toEqual([]);
  });

  it('another removal sends the waiting one first; never twice', async () => {
    const { r, sent } = make();
    r.schedule('a');
    r.schedule('b');
    expect(sent).toEqual(['a']);
    expect(r.pending()).toBe('b');
    r.flush();
    r.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(['a', 'b']);
  });

  it('Undo after the write went out does nothing', async () => {
    const { r, sent } = make();
    r.schedule('a');
    r.flush();
    expect(r.undo()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(['a']);
  });

  it('a failure restores (onFailed) and is not retried', async () => {
    const { r, sent, failed, landed } = make(false);
    r.schedule('a');
    await r.settled();
    expect(sent).toEqual(['a']);
    expect(failed).toEqual(['a']);
    expect(landed).toEqual([]);
  });

  it('a thrown write counts as a failure', async () => {
    const failed: string[] = [];
    const r = createDelayedRemover({
      delayMs: 5000,
      send: () => Promise.reject(new Error('network')),
      onFailed: (id) => failed.push(id),
    });
    r.schedule('a');
    await r.settled();
    expect(failed).toEqual(['a']);
  });

  it('flush on unmount and on visibilitychange hidden (and pagehide)', async () => {
    const { r, sent } = make();
    const doc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    doc.visibilityState = 'visible';
    const win = new EventTarget();
    const stop = flushOnLeave(r, {
      doc: doc as unknown as Document,
      win: win as unknown as Window,
    });
    r.schedule('a');
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toEqual([]);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toEqual(['a']);
    r.schedule('b');
    win.dispatchEvent(new Event('pagehide'));
    expect(sent).toEqual(['a', 'b']);
    r.schedule('c');
    stop();
    expect(sent).toEqual(['a', 'b', 'c']);
    // Listeners are gone: nothing is sent twice.
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(['a', 'b', 'c']);
  });
});

describe('the one-time peek', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPeekLoadForTests();
  });
  afterEach(() => vi.useRealTimers());

  const memory = (): { store: Map<string, string>; read: StorageRead } => {
    const store = new Map<string, string>();
    return {
      store,
      read: () => ({
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      }),
    };
  };
  const throwing: StorageRead = () => {
    throw new Error('SecurityError');
  };
  const run = (
    storage: StorageRead,
    over: { blocked?: () => boolean; reduced?: boolean } = {},
  ): { offsets: Array<number | null>; tips: number; cancel: () => void } => {
    const out = { offsets: [] as Array<number | null>, tips: 0, cancel: (): void => undefined };
    out.cancel = runPlanPeek({
      blocked: over.blocked ?? (() => false),
      firstRow: () => 'row-1',
      reducedMotion: () => over.reduced === true,
      onOffset: (_id, o) => out.offsets.push(o),
      onTip: () => {
        out.tips += 1;
      },
      storage,
    });
    return out;
  };

  it('slides 72px about 600ms after paint, holds 500ms, slides back; then never again', () => {
    const { store, read } = memory();
    const first = run(read);
    vi.advanceTimersByTime(ROW_PEEK_DELAY_MS - 1);
    expect(first.offsets).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(first.offsets).toEqual([-ROW_PEEK_PX]);
    vi.advanceTimersByTime(ROW_PEEK_SLIDE_MS + ROW_PEEK_HOLD_MS);
    expect(first.offsets).toEqual([-ROW_PEEK_PX, 0]);
    vi.advanceTimersByTime(ROW_PEEK_SLIDE_MS);
    expect(first.offsets).toEqual([-ROW_PEEK_PX, 0, null]);
    expect(store.get(PLAN_SWIPE_PEEK_KEY)).toBe('1');
    // A new page load on the same device: the key holds it.
    resetPeekLoadForTests();
    const second = run(read);
    vi.advanceTimersByTime(5000);
    expect(second.offsets).toEqual([]);
  });

  it('storage that throws: once per page load, never twice', () => {
    expect(peekWanted(throwing)).toBe(true);
    const first = run(throwing);
    vi.advanceTimersByTime(5000);
    expect(first.offsets[0]).toBe(-ROW_PEEK_PX);
    const second = run(throwing);
    vi.advanceTimersByTime(5000);
    expect(second.offsets).toEqual([]);
    expect(peekWanted(throwing)).toBe(false);
  });

  it('reduced motion: the tip toast once, no slide, same key', () => {
    const { store, read } = memory();
    const first = run(read, { reduced: true });
    vi.advanceTimersByTime(5000);
    expect(first.tips).toBe(1);
    expect(first.offsets).toEqual([]);
    expect(store.get(PLAN_SWIPE_PEEK_KEY)).toBe('1');
    resetPeekLoadForTests();
    const second = run(read, { reduced: true });
    vi.advanceTimersByTime(5000);
    expect(second.tips).toBe(0);
  });

  it('never while something is active: it waits, unmarked', () => {
    const { store, read } = memory();
    let busy = true;
    const out = run(read, { blocked: () => busy });
    vi.advanceTimersByTime(ROW_PEEK_DELAY_MS * 3);
    expect(out.offsets).toEqual([]);
    expect(store.has(PLAN_SWIPE_PEEK_KEY)).toBe(false);
    busy = false;
    vi.advanceTimersByTime(ROW_PEEK_DELAY_MS);
    expect(out.offsets).toEqual([-ROW_PEEK_PX]);
  });

  it('cancel mid-peek puts the row back at rest; cancel before it shows marks nothing', () => {
    const a = memory();
    const out = run(a.read);
    vi.advanceTimersByTime(ROW_PEEK_DELAY_MS);
    out.cancel();
    expect(out.offsets).toEqual([-ROW_PEEK_PX, null]);
    vi.advanceTimersByTime(5000);
    expect(out.offsets).toEqual([-ROW_PEEK_PX, null]);
    resetPeekLoadForTests();
    const b = memory();
    const early = run(b.read);
    early.cancel();
    vi.advanceTimersByTime(5000);
    expect(early.offsets).toEqual([]);
    expect(b.store.has(PLAN_SWIPE_PEEK_KEY)).toBe(false);
  });

  it('markPeekSeen survives storage that throws', () => {
    expect(() => markPeekSeen(throwing)).not.toThrow();
    expect(peekWanted(throwing)).toBe(false);
  });
});
