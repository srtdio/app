// Pure unit tests for the rollout/experiment bucketing primitive. No database,
// so these run under the default `pnpm test` config alongside the DB-backed
// suite (which gates on RLS_SUITE).

import { describe, expect, it } from 'vitest';
import { bucketFor } from '../../src/server/flags/bucket';

describe('bucketFor', () => {
  it('is deterministic for the same (userId, flagName)', async () => {
    const a = await bucketFor('user-123', 'new_inbox');
    const b = await bucketFor('user-123', 'new_inbox');
    expect(a).toBe(b);
  });

  it('always lands in [0, 99]', async () => {
    for (let i = 0; i < 200; i += 1) {
      const bucket = await bucketFor(`user-${i}`, 'some_flag');
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it('varies by flag name for a fixed user (independent assignment per flag)', async () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      buckets.add(await bucketFor('stable-user', `flag_${i}`));
    }
    // Not all 50 flags can share one bucket; this proves the hash mixes the name.
    expect(buckets.size).toBeGreaterThan(1);
  });

  it('spreads roughly uniformly so a 50% cutoff enables about half', async () => {
    let under50 = 0;
    const n = 1000;
    for (let i = 0; i < n; i += 1) {
      if ((await bucketFor(`spread-${i}`, 'rollout_flag')) < 50) {
        under50 += 1;
      }
    }
    const ratio = under50 / n;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});
