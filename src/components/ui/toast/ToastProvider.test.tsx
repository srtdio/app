import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Motion on by default (this suite runs without a window, where the module
// reads motion as off); one case below turns it off.
const motion = vi.hoisted(() => ({ off: false }));
vi.mock('@/lib/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/motion')>()),
  motionOff: () => motion.off,
}));
import {
  createToastStore,
  ERROR_TOAST_MS,
  EXIT_MS,
  MAX_VISIBLE,
  TOAST_MS,
  TOAST_VIEWPORT_CLASS,
} from '@/components/ui/toast/ToastProvider';

describe('createToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    motion.off = false;
  });

  it('with motion off a dismissed card goes at once (no exit to wait for)', () => {
    motion.off = true;
    const store = createToastStore();
    const id = store.show({ title: 'Plan saved' });
    store.dismiss(id);
    expect(store.getSnapshot()).toEqual([]);
    store.dispose();
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

  it('defaults to TOAST_MS (4000ms), matching the undo window', () => {
    expect(TOAST_MS).toBe(4000);
  });

  it('an error toast stays up ERROR_TOAST_MS (8000ms)', () => {
    expect(ERROR_TOAST_MS).toBe(8000);
    const store = createToastStore();
    const onExpire = vi.fn();
    store.show({ title: "Couldn't save. Try again.", tone: 'error', onExpire });
    vi.advanceTimersByTime(ERROR_TOAST_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('an error toast never runs shorter than ERROR_TOAST_MS; sticky stays sticky', () => {
    const store = createToastStore();
    const short = vi.fn();
    store.show({ title: 'Short', tone: 'error', durationMs: 2000, onExpire: short });
    vi.advanceTimersByTime(ERROR_TOAST_MS - 1);
    expect(short).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(short).toHaveBeenCalledTimes(1);
    store.dispose();
    const sticky = createToastStore();
    sticky.show({ title: 'Sticky', tone: 'error', durationMs: null });
    vi.advanceTimersByTime(1_000_000);
    expect(sticky.getSnapshot().find((t) => t.title === 'Sticky')!.leaving).toBe(false);
    sticky.dispose();
  });

  it('hold pauses the countdown; release resumes with the time left', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    const id = store.show({ title: 'Saved', onExpire });
    vi.advanceTimersByTime(3000);
    store.hold(id, 'hover', true);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]!.leaving).toBe(false);
    store.hold(id, 'hover', false);
    vi.advanceTimersByTime(TOAST_MS - 3000 - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('an undo strip holds through hover, focus and touch together', () => {
    const store = createToastStore();
    const onExpire = vi.fn();
    const id = store.show({ title: 'Post deleted', durationMs: 4000, kind: 'undo', onExpire });
    store.hold(id, 'hover', true);
    store.hold(id, 'focus', true);
    store.hold(id, 'press', true);
    store.hold(id, 'hover', false);
    store.hold(id, 'press', false);
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    store.hold(id, 'focus', false);
    vi.advanceTimersByTime(4000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('a hold never delays a leaving toast from unmounting', () => {
    const store = createToastStore();
    const id = store.show({ title: 'Bye' });
    store.dismiss(id);
    store.hold(id, 'hover', true);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toHaveLength(0);
    store.dispose();
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
    vi.advanceTimersByTime(TOAST_MS - 1);
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
    for (const durationMs of [0, null]) {
      const store = createToastStore();
      store.show({ title: 'Sticky', durationMs });
      vi.advanceTimersByTime(1_000_000);
      expect(store.getSnapshot()).toHaveLength(1);
      expect(store.getSnapshot()[0]!.leaving).toBe(false);
      store.dispose();
    }
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

  it('cap is 1: after 3 shows only the newest is up; the two older ran onExpire once each', () => {
    expect(MAX_VISIBLE).toBe(1);
    const store = createToastStore();
    const expires = [vi.fn(), vi.fn(), vi.fn()];
    for (const [i, onExpire] of expires.entries()) {
      store.show({ title: `t${i + 1}`, durationMs: 0, onExpire });
    }
    const toasts = store.getSnapshot();
    expect(toasts.map((t) => t.title)).toEqual(['t3']);
    expect(expires[0]).toHaveBeenCalledTimes(1);
    expect(expires[1]).toHaveBeenCalledTimes(1);
    expect(expires[2]).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000_000);
    expect(expires[0]).toHaveBeenCalledTimes(1);
    expect(expires[1]).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('a replaced card is removed at once, never left leaving', () => {
    const store = createToastStore();
    const a = store.show({ title: 'A', durationMs: 0 });
    store.show({ title: 'B', durationMs: 0 });
    expect(store.getSnapshot().find((t) => t.id === a)).toBeUndefined();
    expect(store.getSnapshot()).toHaveLength(1);
    // A card already leaving is removed at once too: two cards never overlap.
    const b = store.getSnapshot()[0]!.id;
    store.dismiss(b);
    store.show({ title: 'C', durationMs: 0 });
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['C']);
    store.dispose();
  });

  it('live error + new non-error: the error stays; the card shows with full duration once the error is dismissed', () => {
    const store = createToastStore();
    const err = store.show({ title: "Couldn't send.", tone: 'error', durationMs: 0 });
    const onExpire = vi.fn();
    store.show({ title: 'Mention', durationMs: 4000, onExpire });
    expect(store.getSnapshot().map((t) => t.title)).toEqual(["Couldn't send."]);
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    store.expire(err);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['Mention']);
    vi.advanceTimersByTime(4000 - 1);
    expect(onExpire).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]!.leaving).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('the waiting card shows when the error times out (ERROR_TOAST_MS ceiling)', () => {
    const store = createToastStore();
    store.show({ title: 'Err', tone: 'error' });
    store.show({ title: 'Saved' });
    vi.advanceTimersByTime(ERROR_TOAST_MS + EXIT_MS);
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['Saved']);
    store.dispose();
  });

  it('two non-errors while an error is live: only the newest shows after; the older ran onExpire once', () => {
    const store = createToastStore();
    const err = store.show({ title: 'Err', tone: 'error', durationMs: 0 });
    const older = vi.fn();
    const newer = vi.fn();
    store.show({ title: 'Older', durationMs: 0, onExpire: older });
    store.show({ title: 'Newer', durationMs: 0, onExpire: newer });
    expect(older).toHaveBeenCalledTimes(1);
    expect(newer).not.toHaveBeenCalled();
    store.dismiss(err);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['Newer']);
    expect(older).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('a new error replaces a live error', () => {
    const store = createToastStore();
    const first = vi.fn();
    store.show({ title: 'Err 1', tone: 'error', durationMs: 0, onExpire: first });
    store.show({ title: 'Err 2', tone: 'error', durationMs: 0 });
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['Err 2']);
    expect(first).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('a waiting card dismissed by its caller never shows', () => {
    const store = createToastStore();
    const err = store.show({ title: 'Err', tone: 'error', durationMs: 0 });
    const wait = store.show({ title: 'Wait', durationMs: 0 });
    store.dismiss(wait);
    store.dismiss(err);
    vi.advanceTimersByTime(EXIT_MS);
    expect(store.getSnapshot()).toEqual([]);
    store.dispose();
  });

  it('the viewport sits 12 under the 56 top bar, safe area added, never top-0', () => {
    expect(TOAST_VIEWPORT_CLASS).toContain('top-14');
    expect(TOAST_VIEWPORT_CLASS).toContain('pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]');
    expect(TOAST_VIEWPORT_CLASS).not.toMatch(/(^|\s)top-0(\s|$)/);
    expect(TOAST_VIEWPORT_CLASS).toContain('md:right-4');
    expect(TOAST_VIEWPORT_CLASS).toContain('items-center');
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
    const plain = store.getSnapshot()[0];
    store.show({ title: 'Slot approved', action: { label: 'Undo', onPress } });
    const [withAction] = store.getSnapshot();
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
