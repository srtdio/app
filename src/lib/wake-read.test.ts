// One read per return to the app: focus and visibilitychange share one
// handler, a read still out or one started inside the gap skips, and a
// hidden tab reads nothing. The read tracker answers "is a read out, or did
// one just settle?" for a second trigger.
import { describe, expect, it } from 'vitest';
import { createReadTracker, onWake, type WakeTargets } from '@/lib/wake-read';

/** A window and a document that only hold listeners, with a settable visibility. */
function fakeTargets(): WakeTargets & {
  fire: (type: 'focus' | 'visibilitychange') => void;
  visibility: DocumentVisibilityState;
} {
  const listeners = new Map<string, Set<() => void>>();
  const add = (type: string, l: EventListenerOrEventListenerObject): void => {
    const set = listeners.get(type) ?? new Set();
    set.add(l as () => void);
    listeners.set(type, set);
  };
  const remove = (type: string, l: EventListenerOrEventListenerObject): void => {
    listeners.get(type)?.delete(l as () => void);
  };
  const t = {
    visibility: 'visible' as DocumentVisibilityState,
    win: { addEventListener: add, removeEventListener: remove },
    doc: {
      addEventListener: add,
      removeEventListener: remove,
      get visibilityState(): DocumentVisibilityState {
        return t.visibility;
      },
    },
    fire: (type: 'focus' | 'visibilitychange') => {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
  };
  return t as unknown as WakeTargets & {
    fire: (type: 'focus' | 'visibilitychange') => void;
    visibility: DocumentVisibilityState;
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('onWake', () => {
  it('focus and visibilitychange together read exactly once', async () => {
    const targets = fakeTargets();
    let reads = 0;
    const out = deferred();
    onWake(
      () => {
        reads += 1;
        return out.promise;
      },
      { targets },
    );
    targets.fire('visibilitychange');
    targets.fire('focus');
    expect(reads).toBe(1);
    out.resolve();
    await flush();
  });

  it('a hidden tab reads nothing; the return to visible reads once', () => {
    const targets = fakeTargets();
    let reads = 0;
    onWake(() => void (reads += 1), { targets });
    targets.visibility = 'hidden';
    targets.fire('visibilitychange');
    targets.fire('focus');
    expect(reads).toBe(0);
    targets.visibility = 'visible';
    targets.fire('visibilitychange');
    expect(reads).toBe(1);
  });

  it('the gap: a fast answer never lets the second event of the same wake read', async () => {
    const targets = fakeTargets();
    let at = 0;
    let reads = 0;
    onWake(
      () => {
        reads += 1;
        return Promise.resolve();
      },
      { targets, minGapMs: 2_000, now: () => at },
    );
    targets.fire('visibilitychange');
    await flush();
    at = 50;
    targets.fire('focus');
    expect(reads).toBe(1);
    at = 2_050;
    targets.fire('focus');
    expect(reads).toBe(2);
  });

  it('blocked (another read covers it) reads nothing', () => {
    const targets = fakeTargets();
    let blocked = true;
    let reads = 0;
    onWake(() => void (reads += 1), { targets, blocked: () => blocked });
    targets.fire('focus');
    expect(reads).toBe(0);
    blocked = false;
    targets.fire('focus');
    expect(reads).toBe(1);
  });

  it('the unsubscribe removes both listeners', () => {
    const targets = fakeTargets();
    let reads = 0;
    const off = onWake(() => void (reads += 1), { targets });
    off();
    targets.fire('focus');
    targets.fire('visibilitychange');
    expect(reads).toBe(0);
  });
});

describe('createReadTracker', () => {
  it('fresh while out and for the window after it settles', async () => {
    let at = 0;
    const tracker = createReadTracker(5_000, () => at);
    expect(tracker.fresh()).toBe(false);
    const out = deferred();
    void tracker.track(out.promise);
    expect(tracker.fresh()).toBe(true);
    at = 9_000;
    expect(tracker.fresh()).toBe(true);
    out.resolve();
    await flush();
    at = 13_999;
    expect(tracker.fresh()).toBe(true);
    at = 14_000;
    expect(tracker.fresh()).toBe(false);
  });

  it('a failed read settles it too', async () => {
    let at = 0;
    const tracker = createReadTracker(5_000, () => at);
    await tracker.track(Promise.reject(new Error('x'))).catch(() => {});
    expect(tracker.fresh()).toBe(true);
    at = 5_000;
    expect(tracker.fresh()).toBe(false);
  });
});
