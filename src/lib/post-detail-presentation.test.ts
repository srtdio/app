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
    expect(formatLabel('single_image')).toBe('Single Image');
  });
  it('title-cases an unknown value', () => {
    expect(formatLabel('photo_grid')).toBe('Photo Grid');
  });
});

describe('postStatusLine', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  const updatedAt = '2026-06-22T09:00:00Z'; // 3h before now
  const enteredAt = '2026-06-22T10:00:00Z'; // 2h before now
  const dated = '2025-06-11T12:00:00Z'; // prior year -> dated form with year

  it('reads draft from updated_at (relative)', () => {
    expect(postStatusLine('draft', updatedAt, enteredAt, now)).toBe('Updated 3h ago');
  });
  it('reads review from stage_entered_at (relative)', () => {
    expect(postStatusLine('review', updatedAt, enteredAt, now)).toBe('In review · 2h');
  });
  it('reads approved as a dated event', () => {
    expect(postStatusLine('approved', updatedAt, dated, now)).toBe('Approved Jun 11, 2025');
  });
  it('reads parked as a dated event', () => {
    expect(postStatusLine('parked', updatedAt, dated, now)).toBe('Parked Jun 11, 2025');
  });
  it('reads rejected as a dated event', () => {
    expect(postStatusLine('rejected', updatedAt, dated, now)).toBe('Rejected Jun 11, 2025');
  });
});
