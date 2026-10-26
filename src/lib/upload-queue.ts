// The upload queue's two pure pieces: a concurrency-capped runner and a
// bytes-to-progress mapper. No React, no network; both are unit-tested
// directly (upload-queue.test.ts) and used by the asset upload run loop.

/** Up to three files upload at once; the rest wait in pick order. */
export const UPLOAD_CONCURRENCY = 3;

/**
 * Run `worker` over every item with at most `limit` in flight at a time. Items
 * start in input order; each next one starts as soon as any running one
 * settles. One worker rejecting never stops the others: its slot is freed and
 * the rejection is reported as `{ ok: false, error }` in that item's place.
 * The result array is in input order, whatever order the workers finished in.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const cap = Math.max(1, Math.floor(limit));
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(
    items.length,
  );
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index] as T, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(cap, items.length); i += 1) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/** Bytes sent as a fraction 0..1; 0 when the total is unknown or not positive. Pure. */
export function bytesToFraction(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max(loaded / total, 0), 1);
}

/** A fraction 0..1 as a whole percent 0..100. Pure. */
export function fractionToPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
}

/**
 * Wrap a progress sink so it only ever moves forward: a retried request or
 * part restarts its own byte count, but the file's bar never jumps back.
 * Values are clamped to 0..1 and a repeat of the last value is not re-sent.
 */
export function monotonicProgress(sink: (fraction: number) => void): (fraction: number) => void {
  let last = -1;
  return (fraction) => {
    const clamped = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
    if (clamped <= last) return;
    last = clamped;
    sink(clamped);
  };
}
