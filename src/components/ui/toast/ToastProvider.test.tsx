import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createToastStore,
  DEFAULT_DURATION_MS,
  EXIT_MS,
  MAX_VISIBLE,
} from '@/components/ui/toast/ToastProvider';

describe('createToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('show() renders a toast and returns its id', () => {
    const store = createToastStore();
    const id = store.show({ title: 'Saved' });
    const toasts = store.getSnapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.id).toBe(id);
    expect(toasts[0]!.title).toBe('Saved');
    store.dispose();
  });

  it('auto-dismisses after durationMs, then unmounts after the exit', () => {
    const store = createToastStore();
    store.show({ title: 'Bye', durationMs: 1000 });
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(store.getSnapshot()[0]!.leaving).toBe(false);
    // The auto-dismiss trigger timing is unchanged: at durationMs the card
    // enters its closing phase (still mounted) and unmounts EXIT_MS later.
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]!.leaving).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('defaults to 4000ms, matching the undo window', () => {
    expect(DEFAULT_DURATION_MS).toBe(4000);
  });

  it('keeps the error tone on the shown toast', () => {
    const store = createToastStore();
    store.show({ title: "Couldn't move the post. Try again.", tone: 'error' });
    expect(store.getSnapshot()[0]!.tone).toBe('error');
    store.dispose();
  });

  it('uses the default duration when none is given', () => {
    const store = createToastStore();
    store.show({ title: 'Default' });
    vi.advanceTimersByTime(DEFAULT_DURATION_MS - 1);
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()[0]!.leaving).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('marks a toast leaving on dismiss and removes it after the exit', () => {
    const store = createToastStore();
    const id = store.show({ title: 'Bye', durationMs: 0 });
    store.dismiss(id);
    // Closing phase: still mounted, flagged leaving so the card plays its exit.
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]!.leaving).toBe(true);
    vi.advanceTimersByTime(EXIT_MS - 1);
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('ignores a second dismiss while a toast is already leaving', () => {
    const store = createToastStore();
    const id = store.show({ title: 'Bye', durationMs: 0 });
    store.dismiss(id);
    store.dismiss(id);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('stays sticky when durationMs is 0 or null', () => {
    const store = createToastStore();
    store.show({ title: 'Sticky zero', durationMs: 0 });
    store.show({ title: 'Sticky null', durationMs: null });
    vi.advanceTimersByTime(1_000_000);
    expect(store.getSnapshot()).toHaveLength(2);
    store.dispose();
  });

  it('dismiss() cancels the auto-dismiss timer and removes after the exit', () => {
    const store = createToastStore();
    const id = store.show({ title: 'Removable', durationMs: 1000 });
    store.dismiss(id);
    // The pending auto-dismiss timer is replaced by the removal timer, so the
    // toast is gone after EXIT_MS and nothing double-fires afterwards.
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toHaveLength(0);
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('caps the stack at MAX_VISIBLE, newest first', () => {
    const store = createToastStore();
    for (let i = 1; i <= MAX_VISIBLE + 2; i += 1) {
      store.show({ title: `t${i}`, durationMs: 0 });
    }
    const toasts = store.getSnapshot();
    expect(toasts).toHaveLength(MAX_VISIBLE);
    expect(toasts[0]!.title).toBe(`t${MAX_VISIBLE + 2}`);
    store.dispose();
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const store = createToastStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.show({ title: 'One', durationMs: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.show({ title: 'Two', durationMs: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('omits optional fields rather than storing undefined', () => {
    const store = createToastStore();
    store.show({ title: 'Bare', durationMs: 0 });
    // Optional inputs (description/icon/onPress) are absent; `leaving` is the
    // one always-present closing-phase flag.
    expect(Object.keys(store.getSnapshot()[0]!)).toEqual(['id', 'title', 'leaving']);
    store.dispose();
  });

  it('carries an action through show(); a toast without one has none', () => {
    const store = createToastStore();
    const onPress = vi.fn();
    store.show({ title: 'Plain' });
    store.show({ title: 'Slot approved', action: { label: 'Undo', onPress } });
    const [withAction, plain] = store.getSnapshot();
    expect(withAction!.action?.label).toBe('Undo');
    withAction!.action?.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(plain!.action).toBeUndefined();
    expect('action' in plain!).toBe(false);
    store.dispose();
  });

  it('onExpire runs once when the timer ends', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    store.show({ title: 'Deleted', durationMs: 1000, onExpire });
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(EXIT_MS + 5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('expire() (the X) dismisses and calls onExpire once', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    const id = store.show({ title: 'Deleted', durationMs: 1000, onExpire });
    store.expire(id);
    store.expire(id);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]!.leaving).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('act() runs the action, dismisses, and never calls onExpire', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    const onPress = vi.fn();
    const id = store.show({
      title: 'Deleted',
      durationMs: 1000,
      action: { label: 'Undo', onPress },
      onExpire,
    });
    store.act(id);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]!.leaving).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('a plain dismiss() does not call onExpire', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    const id = store.show({ title: 'Deleted', durationMs: 1000, onExpire });
    store.dismiss(id);
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
    store.dispose();
  });

  it('a toast pushed past the cap expires (accepted)', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    store.show({ title: 'First', durationMs: 1000, onExpire });
    for (let i = 0; i < MAX_VISIBLE; i += 1) store.show({ title: `n${i}` });
    expect(onExpire).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('carries kind through show(); a card has none and no countdown field', () => {
    const store = createToastStore();
    store.show({ title: 'Card', durationMs: 4000 });
    store.show({ title: 'Strip', durationMs: 4000, kind: 'undo' });
    const [strip, card] = store.getSnapshot();
    expect(strip!.kind).toBe('undo');
    expect('kind' in card!).toBe(false);
    for (const t of [strip!, card!]) {
      expect('countdown' in t).toBe(false);
      expect('countdownMs' in t).toBe(false);
    }
    store.dispose();
  });

  it('an undo strip expires (accept) at its durationMs, like a card', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    store.show({ title: 'Deleted', durationMs: 4000, kind: 'undo', onExpire });
    vi.advanceTimersByTime(3999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
  });

  it('a second undo strip replaces the first: first onExpire once, first leaving, second live', () => {
    const store = createToastStore();
    const first = vi.fn();
    const second = vi.fn();
    const a = store.show({ title: 'First', durationMs: 4000, kind: 'undo', onExpire: first });
    const b = store.show({ title: 'Second', durationMs: 4000, kind: 'undo', onExpire: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    const byId = (id: string) => store.getSnapshot().find((t) => t.id === id);
    expect(byId(a)!.leaving).toBe(true);
    expect(byId(b)!.leaving).toBe(false);
    // The first's own timer never fires its onExpire again.
    vi.advanceTimersByTime(EXIT_MS);
    expect(byId(a)).toBeUndefined();
    expect(byId(b)!.leaving).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('only one live strip at a time across many shows', () => {
    const store = createToastStore();
    const expires = [vi.fn(), vi.fn(), vi.fn()];
    for (const [i, onExpire] of expires.entries()) {
      store.show({ title: `s${i}`, durationMs: 0, kind: 'undo', onExpire });
    }
    const live = store.getSnapshot().filter((t) => t.kind === 'undo' && !t.leaving);
    expect(live.map((t) => t.title)).toEqual(['s2']);
    expect(expires[0]).toHaveBeenCalledTimes(1);
    expect(expires[1]).toHaveBeenCalledTimes(1);
    expect(expires[2]).not.toHaveBeenCalled();
    store.dispose();
  });

  it('a strip leaves cards alone, and an undone strip is not accepted by the next', () => {
    const store = createToastStore();
    const cardExpire = vi.fn();
    const undone = vi.fn();
    const onPress = vi.fn();
    store.show({ title: 'Card', durationMs: 0, onExpire: cardExpire });
    const a = store.show({
      title: 'First',
      durationMs: 4000,
      kind: 'undo',
      action: { label: 'Undo', onPress },
      onExpire: undone,
    });
    store.act(a);
    store.show({ title: 'Second', durationMs: 4000, kind: 'undo' });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(undone).not.toHaveBeenCalled();
    const card = store.getSnapshot().find((t) => t.title === 'Card');
    expect(card!.leaving).toBe(false);
    expect(cardExpire).not.toHaveBeenCalled();
    store.dispose();
  });

  it('the card cap never counts the strip, and cards never push the strip out', () => {
    const store = createToastStore();
    const stripExpire = vi.fn();
    store.show({ title: 'Strip', durationMs: 0, kind: 'undo', onExpire: stripExpire });
    for (let i = 1; i <= MAX_VISIBLE; i += 1) store.show({ title: `c${i}`, durationMs: 0 });
    let snap = store.getSnapshot();
    expect(snap.filter((t) => t.kind !== 'undo')).toHaveLength(MAX_VISIBLE);
    expect(snap.filter((t) => t.kind === 'undo')).toHaveLength(1);
    expect(stripExpire).not.toHaveBeenCalled();
    // One more card drops the oldest card, not the strip.
    store.show({ title: `c${MAX_VISIBLE + 1}`, durationMs: 0 });
    snap = store.getSnapshot();
    const cards = snap.filter((t) => t.kind !== 'undo');
    expect(cards).toHaveLength(MAX_VISIBLE);
    expect(cards.map((t) => t.title)).not.toContain('c1');
    expect(snap.find((t) => t.kind === 'undo')!.leaving).toBe(false);
    expect(stripExpire).not.toHaveBeenCalled();
    store.dispose();
  });

  it('a new strip does not push a card past the cap', () => {
    const store = createToastStore();
    const cardExpires = Array.from({ length: MAX_VISIBLE }, () => vi.fn());
    for (const onExpire of cardExpires) store.show({ title: 'c', durationMs: 0, onExpire });
    store.show({ title: 'Strip', durationMs: 0, kind: 'undo' });
    expect(store.getSnapshot().filter((t) => t.kind !== 'undo')).toHaveLength(MAX_VISIBLE);
    for (const fn of cardExpires) expect(fn).not.toHaveBeenCalled();
    store.dispose();
  });
});
