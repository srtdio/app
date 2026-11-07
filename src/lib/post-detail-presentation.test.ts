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
  const dated = '2025-06-11T12:00:00Z'; // over a year before now

  it('reads draft from updated_at (formatRelative)', () => {
    expect(postStatusLine('draft', updatedAt, enteredAt, now)).toBe('Updated 3 hours ago');
    expect(postStatusLine('draft', now.toISOString(), enteredAt, now)).toBe('Updated just now');
    expect(postStatusLine('draft', '2026-06-21T09:00:00Z', enteredAt, now)).toBe(
      'Updated 1 day ago',
    );
  });
  it('reads review from stage_entered_at (formatRelative)', () => {
    expect(postStatusLine('review', updatedAt, enteredAt, now)).toBe('In review · 2 hours ago');
    expect(postStatusLine('review', updatedAt, '2026-06-18T10:00:00Z', now)).toBe(
      'In review · 4 days ago',
    );
  });
  it('reads approved as an event, relative', () => {
    expect(postStatusLine('approved', updatedAt, dated, now)).toBe('Approved 1 year ago');
    expect(postStatusLine('approved', updatedAt, '2026-06-11T12:00:00Z', now)).toBe(
      'Approved 11 days ago',
    );
  });
  it('reads parked as an event, relative', () => {
    expect(postStatusLine('parked', updatedAt, dated, now)).toBe('Parked 1 year ago');
  });
  it('reads rejected as an event, relative', () => {
    expect(postStatusLine('rejected', updatedAt, '2026-04-01T12:00:00Z', now)).toBe(
      'Rejected 2 months ago',
    );
  });
});
