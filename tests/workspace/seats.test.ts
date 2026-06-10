// Pure unit coverage for seat usage: plan allowances, the narrowing guard, and
// the usage derivation across capped / unlimited / over-capacity inputs. No
// database, so this runs under the root `pnpm test` as well as the workspace
// config.

import { describe, expect, it } from 'vitest';
import {
  computeSeatUsage,
  isPlanTier,
  PLAN_SEAT_LIMITS,
  seatLimitForPlan,
} from '../../packages/workspace/src/index';

describe('plan seat allowances', () => {
  it('matches the PRD tier table', () => {
    expect(PLAN_SEAT_LIMITS).toEqual({ solo: 1, studio: 4, agency: 8, enterprise: null });
    expect(seatLimitForPlan('studio')).toBe(4);
    expect(seatLimitForPlan('enterprise')).toBeNull();
  });
});

describe('isPlanTier', () => {
  it('accepts the four known tiers and rejects anything else', () => {
    expect(isPlanTier('solo')).toBe(true);
    expect(isPlanTier('agency')).toBe(true);
    expect(isPlanTier('team')).toBe(false);
    expect(isPlanTier('')).toBe(false);
  });
});

describe('computeSeatUsage', () => {
  it('reports remaining seats below the cap', () => {
    expect(computeSeatUsage('studio', 2)).toEqual({
      used: 2,
      limit: 4,
      remaining: 2,
      unlimited: false,
      atCapacity: false,
    });
  });

  it('flags at-capacity when every seat is taken', () => {
    const usage = computeSeatUsage('solo', 1);
    expect(usage.remaining).toBe(0);
    expect(usage.atCapacity).toBe(true);
  });

  it('clamps remaining at 0 and stays at-capacity when over the cap', () => {
    const usage = computeSeatUsage('solo', 3);
    expect(usage).toEqual({
      used: 3,
      limit: 1,
      remaining: 0,
      unlimited: false,
      atCapacity: true,
    });
  });

  it('treats enterprise as unlimited with no remaining figure', () => {
    expect(computeSeatUsage('enterprise', 25)).toEqual({
      used: 25,
      limit: null,
      remaining: null,
      unlimited: true,
      atCapacity: false,
    });
  });

  it('floors negative and fractional counts to a whole non-negative used', () => {
    expect(computeSeatUsage('studio', -2).used).toBe(0);
    expect(computeSeatUsage('studio', 2.9).used).toBe(2);
  });
});
