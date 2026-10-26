import { describe, expect, it } from 'vitest';
import {
  UPLOAD_CONCURRENCY,
  bytesToFraction,
  fractionToPercent,
  monotonicProgress,
  runWithConcurrency,
} from '@/lib/upload-queue';

/** A job the test settles by hand, to hold slots open. */
interface Gate {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runWithConcurrency', () => {
  it('the shared cap is three', () => {
    expect(UPLOAD_CONCURRENCY).toBe(3);
  });

  it('never has more than 3 in flight and starts the rest as slots free, in order', async () => {
    const gates = new Map<number, Gate>();
    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const run = runWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, (item) => {
      started.push(item);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<number>((resolve, reject) => {
        gates.set(item, {
          resolve: () => {
            inFlight -= 1;
            resolve(item * 10);
          },
          reject: (error) => {
            inFlight -= 1;
            reject(error);
          },
        });
      });
    });

    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(inFlight).toBe(3);

    gates.get(1)?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    gates.get(0)?.resolve();
    gates.get(2)?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    for (const item of [3, 4, 5]) gates.get(item)?.resolve();
    await flush();
    gates.get(6)?.resolve();

    const results = await run;
    expect(peak).toBe(3);
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it('one rejected job never stops the others and is reported in its own place', async () => {
    const seen: string[] = [];
    const results = await runWithConcurrency(['a', 'b', 'c', 'd', 'e'], 3, async (item) => {
      seen.push(item);
      if (item === 'b') throw new Error('boom');
      return item.toUpperCase();
    });
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(results[0]).toEqual({ ok: true, value: 'A' });
    expect(results[1]?.ok).toBe(false);
    expect(results.slice(2)).toEqual([
      { ok: true, value: 'C' },
      { ok: true, value: 'D' },
      { ok: true, value: 'E' },
    ]);
  });

  it('keeps input order in the result even when later items finish first', async () => {
    const results = await runWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual([
      { ok: true, value: 30 },
      { ok: true, value: 10 },
      { ok: true, value: 20 },
    ]);
  });

  it('handles an empty list and a non-positive limit (treated as 1)', async () => {
    expect(await runWithConcurrency([], 3, async () => 1)).toEqual([]);
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });
});

describe('progress mapping', () => {
  it('maps bytes sent to a clamped fraction and a whole percent', () => {
    expect(bytesToFraction(0, 200)).toBe(0);
    expect(bytesToFraction(50, 200)).toBe(0.25);
    expect(bytesToFraction(200, 200)).toBe(1);
    expect(bytesToFraction(250, 200)).toBe(1);
    expect(bytesToFraction(-5, 200)).toBe(0);
    expect(bytesToFraction(5, 0)).toBe(0);
    expect(bytesToFraction(Number.NaN, 10)).toBe(0);
    expect(fractionToPercent(0.256)).toBe(26);
    expect(fractionToPercent(1.4)).toBe(100);
    expect(fractionToPercent(Number.NaN)).toBe(0);
  });

  it('monotonicProgress only ever moves forward, even when a retry restarts its bytes', () => {
    const seen: number[] = [];
    const report = monotonicProgress((f) => seen.push(f));
    for (const [loaded, total] of [
      [0, 100],
      [40, 100],
      [20, 100], // a retried part restarts its own count
      [40, 100], // a repeat is not re-sent
      [80, 100],
      [120, 100], // over the total is clamped
    ] as const) {
      report(bytesToFraction(loaded, total));
    }
    expect(seen).toEqual([0, 0.4, 0.8, 1]);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? -1);
    }
  });
});
