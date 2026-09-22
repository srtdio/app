import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer } from '@/lib/chat/read-cursor';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('fires once with the latest value after the window, and can be cancelled', () => {
    const fn = vi.fn();
    const d = createDebouncer<string>(fn, 1000);
    d.schedule('a');
    vi.advanceTimersByTime(500);
    d.schedule('b');
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');

    d.schedule('c');
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
