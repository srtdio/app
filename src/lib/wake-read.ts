// One read per return to the app. A wake fires window focus and the tab's
// visibilitychange (often both, in the same task), and each listener used to
// read on its own. onWake is the one handler for both: it reads only while the
// tab is visible, never while the read it started is still out, never inside
// `minGapMs` of the last start, and never while `blocked()` says another read
// already covers it. createReadTracker answers "did a read of this just
// settle, or is one out?" so a second trigger can skip it. Both are off every
// paint path: they only decide whether a background read starts.

/** The two targets a wake fires on (the app's window and document; tests pass the same). */
export interface WakeTargets {
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export interface WakeOptions {
  /** The least time between two starts (ms); default 0 (the in-flight guard only). */
  minGapMs?: number;
  /** True while another read already covers this one (it skips). */
  blocked?: () => boolean;
  now?: () => number;
  targets?: WakeTargets;
}

/**
 * Run `read` once per wake (focus or visibilitychange to visible). A read that
 * returns a promise holds the guard until it settles. Returns the unsubscribe.
 */
export function onWake(read: () => Promise<unknown> | void, opts: WakeOptions = {}): () => void {
  const targets: WakeTargets = opts.targets ?? { win: window, doc: document };
  const now = opts.now ?? (() => Date.now());
  const minGapMs = opts.minGapMs ?? 0;
  let inFlight = false;
  let lastStart: number | null = null;
  const handler = (): void => {
    if (targets.doc.visibilityState !== 'visible') return;
    if (inFlight || opts.blocked?.() === true) return;
    const at = now();
    if (lastStart !== null && at - lastStart < minGapMs) return;
    lastStart = at;
    const out = read();
    if (out === undefined) return;
    inFlight = true;
    const done = (): void => {
      inFlight = false;
    };
    void out.then(done, done);
  };
  targets.win.addEventListener('focus', handler);
  targets.doc.addEventListener('visibilitychange', handler);
  return () => {
    targets.win.removeEventListener('focus', handler);
    targets.doc.removeEventListener('visibilitychange', handler);
  };
}

export interface ReadTracker {
  /** Note a read: out until it settles. Returns the same promise. */
  track: <T>(read: Promise<T>) => Promise<T>;
  /** True while a tracked read is out, or one settled less than `windowMs` ago. */
  fresh: () => boolean;
}

/** Tracks one kind of read so a second trigger inside `windowMs` can skip it. */
export function createReadTracker(windowMs: number, now: () => number = Date.now): ReadTracker {
  let out = 0;
  let settledAt: number | null = null;
  return {
    track: (read) => {
      out += 1;
      const settle = (): void => {
        out -= 1;
        settledAt = now();
      };
      void read.then(settle, settle);
      return read;
    },
    fresh: () => out > 0 || (settledAt !== null && now() - settledAt < windowMs),
  };
}
