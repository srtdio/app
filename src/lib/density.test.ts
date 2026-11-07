// @vitest-environment jsdom
// Density (Compact / Cozy / Calm; Cozy default, 8 Nov 2026): the device boots
// from its cache onto <html data-density> before React paints; the server
// value reconciles after the profile read unless the person picked one here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeDensity,
  adoptUserDensity,
  applyDensity,
  bootDensity,
  cacheDensity,
  DEFAULT_DENSITY,
  DENSITIES,
  DENSITY_KEY,
  DENSITY_USER_KEY,
  isDensity,
  reconcileDensity,
  resetDensityForTest,
  revertDensity,
  setDensityLocal,
} from '@/lib/density';

const html = (): string | undefined => document.documentElement.dataset.density;

beforeEach(() => {
  localStorage.clear();
  resetDensityForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetDensityForTest();
});

describe('the three densities', () => {
  it('Compact, Cozy, Calm in order; Cozy is the default', () => {
    expect(DENSITIES).toEqual(['compact', 'cozy', 'calm']);
    expect(DEFAULT_DENSITY).toBe('cozy');
    expect(DENSITY_KEY).toBe('sorted-density');
    expect(DENSITY_USER_KEY).toBe('sorted-density:');
  });

  it('isDensity accepts only the three names', () => {
    for (const d of DENSITIES) expect(isDensity(d)).toBe(true);
    for (const bad of ['', 'Cozy', 'roomy', null, undefined, 1, {}]) {
      expect(isDensity(bad)).toBe(false);
    }
  });

  it('activeDensity reads <html data-density>; Cozy when unset or unknown', () => {
    expect(activeDensity()).toBe('cozy');
    document.documentElement.dataset.density = 'compact';
    expect(activeDensity()).toBe('compact');
    document.documentElement.dataset.density = 'nonsense';
    expect(activeDensity()).toBe('cozy');
  });

  it('applyDensity sets the attribute and nothing else (no storage write)', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    applyDensity('calm');
    expect(html()).toBe('calm');
    expect(set).not.toHaveBeenCalled();
  });
});

describe('bootDensity (main.tsx, before React paints)', () => {
  it('no cache: Cozy on <html>', () => {
    expect(bootDensity()).toBe('cozy');
    expect(html()).toBe('cozy');
  });

  it('boots from the device cache', () => {
    localStorage.setItem('sorted-density', 'compact');
    expect(bootDensity()).toBe('compact');
    expect(html()).toBe('compact');
    localStorage.setItem('sorted-density', 'calm');
    expect(bootDensity()).toBe('calm');
    expect(html()).toBe('calm');
  });

  it('an invalid cached value is ignored (Cozy)', () => {
    for (const bad of ['', 'Compact', 'huge', '{"d":"calm"}']) {
      localStorage.setItem('sorted-density', bad);
      expect(bootDensity()).toBe('cozy');
      expect(html()).toBe('cozy');
    }
  });

  it('storage that throws is tolerated: Cozy, and the attribute still applies', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => bootDensity()).not.toThrow();
    expect(bootDensity()).toBe('cozy');
    expect(html()).toBe('cozy');
  });

  it('is sync and reads only the one boot key', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const result = bootDensity();
    expect(result).not.toBeInstanceOf(Promise);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('sorted-density');
  });
});

describe('cacheDensity', () => {
  it('writes the boot key and, for an account, its own key', () => {
    cacheDensity('u-1', 'calm');
    expect(localStorage.getItem('sorted-density')).toBe('calm');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('calm');
    cacheDensity(null, 'compact');
    expect(localStorage.getItem('sorted-density')).toBe('compact');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('calm');
  });

  it('storage that throws on write is tolerated', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => cacheDensity('u-1', 'calm')).not.toThrow();
    expect(() => setDensityLocal('u-1', 'calm')).not.toThrow();
    // The attribute still applies for this load.
    expect(html()).toBe('calm');
  });
});

describe('adoptUserDensity (a session is known)', () => {
  it("applies this account's cached density and makes it the boot value", () => {
    localStorage.setItem('sorted-density', 'compact');
    bootDensity();
    localStorage.setItem('sorted-density:u-2', 'calm');
    adoptUserDensity('u-2');
    expect(html()).toBe('calm');
    expect(localStorage.getItem('sorted-density')).toBe('calm');
  });

  it('no (or an invalid) account cache: leaves the boot density as it is', () => {
    localStorage.setItem('sorted-density', 'compact');
    bootDensity();
    adoptUserDensity('u-new');
    expect(html()).toBe('compact');
    localStorage.setItem('sorted-density:u-bad', 'wide');
    adoptUserDensity('u-bad');
    expect(html()).toBe('compact');
    expect(localStorage.getItem('sorted-density')).toBe('compact');
  });
});

describe('reconcileDensity (the profile read landed)', () => {
  it('applies and caches the server value', () => {
    bootDensity();
    reconcileDensity('u-1', 'compact');
    expect(html()).toBe('compact');
    expect(localStorage.getItem('sorted-density')).toBe('compact');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('compact');
  });

  it('ignores a missing or invalid server value', () => {
    bootDensity();
    for (const bad of [undefined, null, '', 'roomy', 3]) {
      reconcileDensity('u-1', bad);
      expect(html()).toBe('cozy');
    }
    expect(localStorage.getItem('sorted-density:u-1')).toBeNull();
  });

  it('never overrides a local pick made this session (its save is in flight or done)', () => {
    bootDensity();
    setDensityLocal('u-1', 'calm');
    reconcileDensity('u-1', 'compact');
    expect(html()).toBe('calm');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('calm');
  });

  it('a local pick by one account does not block another account', () => {
    setDensityLocal('u-1', 'calm');
    reconcileDensity('u-2', 'compact');
    expect(html()).toBe('compact');
    expect(localStorage.getItem('sorted-density:u-2')).toBe('compact');
  });
});

describe('setDensityLocal and revertDensity (the account menu pick)', () => {
  it('applies and caches at once, and returns the previous density', () => {
    bootDensity();
    expect(setDensityLocal('u-1', 'compact')).toBe('cozy');
    expect(html()).toBe('compact');
    expect(localStorage.getItem('sorted-density')).toBe('compact');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('compact');
    expect(setDensityLocal('u-1', 'calm')).toBe('compact');
    expect(html()).toBe('calm');
  });

  it('with no account yet: applies and caches the boot key only', () => {
    expect(setDensityLocal(null, 'calm')).toBe('cozy');
    expect(html()).toBe('calm');
    expect(localStorage.getItem('sorted-density')).toBe('calm');
    expect(localStorage.length).toBe(1);
  });

  it('revertDensity puts the attribute and both caches back', () => {
    bootDensity();
    const previous = setDensityLocal('u-1', 'compact');
    revertDensity('u-1', previous);
    expect(html()).toBe('cozy');
    expect(localStorage.getItem('sorted-density')).toBe('cozy');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('cozy');
  });

  it('resetDensityForTest clears the attribute and the local-pick guard', () => {
    setDensityLocal('u-1', 'calm');
    resetDensityForTest();
    expect(html()).toBeUndefined();
    reconcileDensity('u-1', 'compact');
    expect(html()).toBe('compact');
  });
});
