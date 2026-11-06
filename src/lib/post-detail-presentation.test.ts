import { describe, expect, it } from 'vitest';
import { formatLabel, platformLabel, postStatusLine } from './post-detail-presentation';

describe('platformLabel', () => {
  it('maps known platforms', () => {
    expect(platformLabel('linkedin')).toBe('LinkedIn');
    expect(platformLabel('x')).toBe('X');
  });
  it('title-cases an unknown value', () => {
    expect(platformLabel('some_new_network')).toBe('Some New Network');
  });
});

describe('formatLabel', () => {
  it('maps known formats', () => {
    expect(formatLabel('single_image')).toBe('Single image');
    expect(formatLabel('single_image', 'x')).toBe('Image');
    expect(formatLabel('reel')).toBe('Reel');
  });
  it('sentence-cases an unknown value', () => {
    expect(formatLabel('photo_grid')).toBe('Photo grid');
  });
});

describe('postStatusLine', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  const updatedAt = '2026-06-22T09:00:00Z'; // 3h before now
  const enteredAt = '2026-06-22T10:00:00Z'; // 2h before now
  const dated = '2025-06-11T12:00:00Z'; // prior year -> dated form with year

  it('reads draft from updated_at (formatWhen, never relative)', () => {
    expect(postStatusLine('draft', updatedAt, enteredAt, now, 'UTC')).toBe('Updated 9:00 AM');
    expect(postStatusLine('draft', now.toISOString(), enteredAt, now, 'UTC')).toBe(
      'Updated 12:00 PM',
    );
    expect(postStatusLine('draft', '2026-06-21T09:00:00Z', enteredAt, now, 'UTC')).toBe(
      'Updated Yesterday',
    );
  });
  it('reads review from stage_entered_at (formatWhen, never relative)', () => {
    expect(postStatusLine('review', updatedAt, enteredAt, now, 'UTC')).toBe('In review · 10:00 AM');
    // 22 Jun 2026 is a Monday; 18 Jun is the Thursday before.
    expect(postStatusLine('review', updatedAt, '2026-06-18T10:00:00Z', now, 'UTC')).toBe(
      'In review · Thu',
    );
  });
  it('reads approved as a dated event', () => {
    expect(postStatusLine('approved', updatedAt, dated, now, 'UTC')).toBe('Approved 11 Jun 2025');
    expect(postStatusLine('approved', updatedAt, '2026-06-11T12:00:00Z', now, 'UTC')).toBe(
      'Approved 11 Jun',
    );
  });
  it('reads parked as a dated event', () => {
    expect(postStatusLine('parked', updatedAt, dated, now, 'UTC')).toBe('Parked 11 Jun 2025');
  });
  it('reads rejected as a dated event', () => {
    expect(postStatusLine('rejected', updatedAt, dated, now, 'UTC')).toBe('Rejected 11 Jun 2025');
  });
});
