// X5 fix 4 (FT19): the header count reflects the filter.
import { describe, expect, it } from 'vitest';
import { headerCountLabel, viewFiltered } from '@/components/pages/PipelinePage';

const base = { stage: 'all', search: '', dateWindow: 'any' as const, customRange: null };

describe('X5 honest header count', () => {
  it('a Review filter over five posts with one in Review reads "1 of 5 posts"', () => {
    expect(headerCountLabel(1, 5, viewFiltered({ ...base, stage: 'review' }))).toBe('1 of 5 posts');
  });

  it('search and date filters also switch to "{shown} of {total}"', () => {
    expect(viewFiltered({ ...base, search: 'launch' })).toBe(true);
    expect(viewFiltered({ ...base, dateWindow: 'week' })).toBe(true);
    expect(headerCountLabel(0, 1, true)).toBe('0 of 1 post');
  });

  it('no filter on: the plain total', () => {
    expect(viewFiltered(base)).toBe(false);
    expect(headerCountLabel(5, 5, false)).toBe('5 posts');
  });
});
