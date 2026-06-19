// Pure coverage for the cutover safety harness: the verify-only v1 freeze
// interpreter, the row-count parity checksum, and the digest fold. These are
// critical-surface (a weak gate could commit a partial or contaminated cutover).
// No database.

import { describe, expect, it } from 'vitest';

import { type FreezeEvidence } from '../../packages/etl/src/source';
import {
  combineDigests,
  compareCounts,
  interpretFreeze,
  type LoadedCounts,
  type PlanCounts,
  type TargetCounts,
} from '../../packages/etl/src/verify';

// --- interpretFreeze: the verify-only v1 interceptor ---------------------------

describe('interpretFreeze', () => {
  const evidence = (over: Partial<FreezeEvidence>): FreezeEvidence => ({
    inRecovery: false,
    configs: [],
    ...over,
  });

  it('treats a standby (in recovery) as frozen', () => {
    expect(interpretFreeze(evidence({ inRecovery: true })).frozen).toBe(true);
  });

  it('treats a database/role read-only default as frozen', () => {
    expect(
      interpretFreeze(evidence({ configs: ['default_transaction_read_only=on'] })).frozen,
    ).toBe(true);
  });

  it('accepts the usual truthy spellings and surrounding whitespace', () => {
    for (const cfg of [
      'default_transaction_read_only=true',
      'default_transaction_read_only = on',
      '  default_transaction_read_only=1  ',
      'DEFAULT_TRANSACTION_READ_ONLY=yes',
    ]) {
      expect(interpretFreeze(evidence({ configs: [cfg] })).frozen).toBe(true);
    }
  });

  it('is not frozen when no read-only default and not a standby', () => {
    const result = interpretFreeze(evidence({ configs: ['statement_timeout=5000'] }));
    expect(result.frozen).toBe(false);
    expect(result.evidence).toMatch(/not a standby/i);
  });

  it('does not match a read-only value that is off', () => {
    expect(
      interpretFreeze(evidence({ configs: ['default_transaction_read_only=off'] })).frozen,
    ).toBe(false);
  });
});

// --- compareCounts: the row-count parity checksum ------------------------------

describe('compareCounts', () => {
  const plan: PlanCounts = { briefs: 25, posts: 147, postVersions: 237, comments: 682 };
  const loaded: LoadedCounts = { ...plan, assets: 223 };
  const target: TargetCounts = { ...plan, assets: 223 };

  it('passes when plan, loaded and target all agree', () => {
    expect(compareCounts({ plan, loaded, target }).ok).toBe(true);
  });

  it('fails when the load silently drops rows (plan != loaded)', () => {
    const result = compareCounts({ plan, loaded: { ...loaded, posts: 146 }, target });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/posts\(plan=147,loaded=146/);
  });

  it('fails when the target workspace was not empty (loaded != target)', () => {
    const result = compareCounts({ plan, loaded, target: { ...target, posts: 200 } });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/posts\(plan=147,loaded=147,target=200\)/);
  });

  it('checks assets as loaded == target only, with no source plan', () => {
    const assetRow = compareCounts({ plan, loaded, target }).rows.find((r) => r.table === 'assets');
    expect(assetRow?.plan).toBeNull();
    expect(compareCounts({ plan, loaded, target: { ...target, assets: 222 } }).ok).toBe(false);
  });
});

// --- combineDigests: stable fold of per-table digests --------------------------

describe('combineDigests', () => {
  const parts = [
    { table: 'briefs', digest: 'aaa' },
    { table: 'posts', digest: 'bbb' },
  ];

  it('is deterministic for the same parts', () => {
    expect(combineDigests(parts)).toBe(combineDigests(parts));
  });

  it('changes when any digest changes', () => {
    const changed = [parts[0]!, { table: 'posts', digest: 'ccc' }];
    expect(combineDigests(changed)).not.toBe(combineDigests(parts));
  });

  it('is order-sensitive across tables', () => {
    expect(combineDigests([parts[1]!, parts[0]!])).not.toBe(combineDigests(parts));
  });
});
