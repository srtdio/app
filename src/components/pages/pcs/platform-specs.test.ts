import { describe, expect, it } from 'vitest';
import {
  PLATFORM_FEED_SPECS,
  formatRatio,
  specFor,
  verdict,
} from '@/components/pages/pcs/platform-specs';

describe('platform feed specs', () => {
  it('bounds LinkedIn at 4:5 tall and 1.91:1 wide', () => {
    const spec = PLATFORM_FEED_SPECS['linkedin']!;
    expect(spec.minRatio).toBeCloseTo(0.8, 10);
    expect(spec.minRatioLabel).toBe('4:5');
    expect(spec.maxRatio).toBeCloseTo(1.91, 10);
    expect(spec.maxRatioLabel).toBe('1.91:1');
    expect(spec.label).toBe('LinkedIn');
  });

  it('resolves a spec only for known platforms', () => {
    expect(specFor('linkedin')).not.toBeNull();
    expect(specFor('myspace')).toBeNull();
    expect(specFor(null)).toBeNull();
    expect(specFor(undefined)).toBeNull();
  });
});

describe('verdict', () => {
  it('fits anything inside the bounds, with zero loss', () => {
    // Square, exactly-4:5, exactly-1.91:1 and a mid landscape all fit.
    for (const [w, h] of [
      [1080, 1080],
      [1080, 1350],
      [1910, 1000],
      [1200, 800],
    ] as const) {
      const v = verdict(w, h, 'linkedin')!;
      expect(v.fit).toBe('fits');
      expect(v.cropAxis).toBeNull();
      expect(v.percentLost).toBe(0);
      expect(v.ratio).toBeCloseTo(w / h, 10);
    }
    expect(verdict(1080, 1350, 'linkedin')!.ratioLabel).toBe('4:5');
  });

  it('crops a 9:16 portrait to 4:5, losing ~29.7% off the vertical axis', () => {
    const v = verdict(1080, 1920, 'linkedin')!;
    expect(v.fit).toBe('crops-to');
    expect(v.ratio).toBeCloseTo(0.8, 10);
    expect(v.ratioLabel).toBe('4:5');
    expect(v.cropAxis).toBe('y');
    // Visible height is w / 0.8 = 1350 of 1920 rows: 570 / 1920 = 29.6875% lost.
    expect(v.percentLost).toBeCloseTo(29.6875, 4);
  });

  it('crops an ultra-wide to 1.91:1 off the horizontal axis', () => {
    const v = verdict(3000, 1000, 'linkedin')!;
    expect(v.fit).toBe('crops-to');
    expect(v.ratio).toBeCloseTo(1.91, 10);
    expect(v.ratioLabel).toBe('1.91:1');
    expect(v.cropAxis).toBe('x');
    // Visible width is 1000 * 1.91 = 1910 of 3000 columns.
    expect(v.percentLost).toBeCloseTo((1 - 1910 / 3000) * 100, 4);
  });

  it('returns null for a null or unknown platform and bad dimensions', () => {
    expect(verdict(1080, 1350, null)).toBeNull();
    expect(verdict(1080, 1350, undefined)).toBeNull();
    expect(verdict(1080, 1350, 'tiktok')).toBeNull();
    expect(verdict(0, 1350, 'linkedin')).toBeNull();
    expect(verdict(1080, -5, 'linkedin')).toBeNull();
  });
});

describe('formatRatio', () => {
  it('reduces small exact ratios and falls back to a decimal', () => {
    expect(formatRatio(1080, 1350)).toBe('4:5');
    expect(formatRatio(1080, 1080)).toBe('1:1');
    expect(formatRatio(1920, 1080)).toBe('16:9');
    expect(formatRatio(1913, 1000)).toBe('1.91:1');
    expect(formatRatio(1000, 1913)).toBe('1:1.91');
    expect(formatRatio(0, 100)).toBe('');
  });
});
