import { describe, expect, it } from 'vitest';
import { captionCounterText, groupDigits } from './caption-limits';

describe('caption-limits en-US grouping', () => {
  it('groups in threes, never Indian lakh grouping', () => {
    expect(groupDigits(100000)).toBe('100,000');
    expect(groupDigits(4000)).toBe('4,000');
    expect(groupDigits(999)).toBe('999');
    expect(captionCounterText(100000, 63206)).toBe('100,000 / 63,206');
  });
});
