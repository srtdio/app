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
});
