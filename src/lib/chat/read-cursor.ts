// Pure scheduling helpers for the read-position and unread refreshes. Both are
// trailing debounces (the last call within the window wins, fired once the
// window closes) with injected timers, so the hook and provider stay thin and
// the timing is unit-tested without React.

/** The read cursor is written this long after the newest message became visible. */
export const READ_CURSOR_DEBOUNCE_MS = 1_000;

/** chat_unread_counts is re-read this long after the last incoming live message. */
export const UNREAD_REFRESH_DEBOUNCE_MS = 2_000;

export interface Debouncer<T> {
  /** Schedule `fn` with the latest value; an earlier pending call is replaced. */
  schedule: (value: T) => void;
  /** Drop the pending call, if any. */
  cancel: () => void;
}

/**
 * Trailing debounce over one argument. `setTimer` / `clearTimer` default to the
 * platform timers and are injected in tests.
 */
export function createDebouncer<T>(
  fn: (value: T) => void,
  delayMs: number,
  timers: {
    setTimer?: (cb: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Debouncer<T> {
  const setTimer = timers.setTimer ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));
  const clearTimer =
    timers.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let pending: unknown = null;
  let latest: T | undefined;
  return {
    schedule: (value) => {
      latest = value;
      if (pending !== null) clearTimer(pending);
      pending = setTimer(() => {
        pending = null;
        fn(latest as T);
      }, delayMs);
    },
    cancel: () => {
      if (pending !== null) {
        clearTimer(pending);
        pending = null;
      }
    },
  };
}
