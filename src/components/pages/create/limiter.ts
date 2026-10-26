// Run at most `limit` async jobs at a time; the rest wait in pick order. The
// create sheet uploads up to three files at once with it. Pure (no React).

/** Up to three files upload at once (one shared cap with the Assets upload run). */
export { UPLOAD_CONCURRENCY } from '@/lib/upload-queue';

interface Limiter {
  run<T>(job: () => Promise<T>): Promise<T>;
}

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  function next(): void {
    if (active >= limit) return;
    const start = waiting.shift();
    if (start !== undefined) start();
  }
  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          active += 1;
          job()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              next();
            });
        });
        next();
      });
    },
  };
}
