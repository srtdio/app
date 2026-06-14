import { describe, expect, it } from 'vitest';
import { shapeBuckets } from '@/lib/buckets';

// The query already filters + orders, but shapeBuckets re-applies both so the
// archived filter and position sort are guaranteed regardless of how the rows
// arrive. Exercised directly on the pure helper, no database needed.

interface Raw {
  id: string;
  name: string;
  color_hex: string;
  position: number;
  archived: boolean;
}

function row(over: Partial<Raw>): Raw {
  return { id: 'b', name: 'Bucket', color_hex: '#5e6ad2', position: 0, archived: false, ...over };
}

describe('shapeBuckets', () => {
  it('orders by position ascending and flattens to options', () => {
    const out = shapeBuckets([
      row({ id: 'b2', name: 'Second', position: 2, color_hex: '#111111' }),
      row({ id: 'b0', name: 'First', position: 0, color_hex: '#222222' }),
      row({ id: 'b1', name: 'Middle', position: 1, color_hex: '#333333' }),
    ]);
    expect(out.map((b) => b.id)).toEqual(['b0', 'b1', 'b2']);
    expect(out[0]).toEqual({ id: 'b0', name: 'First', colorHex: '#222222', position: 0 });
  });

  it('drops archived buckets defensively', () => {
    const out = shapeBuckets([
      row({ id: 'live', archived: false }),
      row({ id: 'gone', archived: true }),
    ]);
    expect(out.map((b) => b.id)).toEqual(['live']);
  });

  it('returns an empty array when there are no rows', () => {
    expect(shapeBuckets([])).toEqual([]);
  });
});
