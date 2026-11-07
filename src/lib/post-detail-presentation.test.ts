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
  // Mon 22 Jun 2026, noon UTC: day-level cases sit at noon UTC so the civil
  // gap is the same in any device zone.
  const now = new Date('2026-06-22T12:00:00Z');
  const updatedAt = '2026-06-22T09:00:00Z'; // 3h before now
  const enteredAt = '2026-06-22T10:00:00Z'; // 2h before now
  const dated = '2025-06-11T12:00:00Z'; // over a year before now

  it('reads draft from updated_at (formatAgo)', () => {
    expect(postStatusLine('draft', updatedAt, enteredAt, now)).toBe('Updated 3h');
    expect(postStatusLine('draft', now.toISOString(), enteredAt, now)).toBe('Updated just now');
    expect(postStatusLine('draft', '2026-06-21T12:00:00Z', enteredAt, now)).toBe(
      'Updated Yesterday',
    );
  });
  it('reads review from stage_entered_at (formatAgo)', () => {
    expect(postStatusLine('review', updatedAt, enteredAt, now)).toBe('In review · 2h');
    expect(postStatusLine('review', updatedAt, '2026-06-18T10:00:00Z', now)).toBe(
      'In review · Thu',
    );
  });
  it('reads approved as an event, short', () => {
    expect(postStatusLine('approved', updatedAt, dated, now)).toBe('Approved 11 Jun 2025');
    expect(postStatusLine('approved', updatedAt, '2026-06-11T12:00:00Z', now)).toBe(
      'Approved 11 Jun',
    );
  });
  it('reads parked as an event, short', () => {
    expect(postStatusLine('parked', updatedAt, dated, now)).toBe('Parked 11 Jun 2025');
  });
  it('reads rejected as an event, short', () => {
    expect(postStatusLine('rejected', updatedAt, '2026-04-01T12:00:00Z', now)).toBe(
      'Rejected 1 Apr',
    );
  });
});
