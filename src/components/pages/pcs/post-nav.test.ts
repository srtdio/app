import { describe, expect, it } from 'vitest';
import { hasInAppHistory } from '@/components/pages/pcs/post-nav';

// FT13: Back goes one step back only when the router recorded in-app history.
describe('hasInAppHistory', () => {
  it('is true past the first entry, false on it and on a foreign or empty state', () => {
    expect(hasInAppHistory({ idx: 3, key: 'k', usr: null })).toBe(true);
    expect(hasInAppHistory({ idx: 0 })).toBe(false);
    expect(hasInAppHistory(null)).toBe(false);
    expect(hasInAppHistory(undefined)).toBe(false);
    expect(hasInAppHistory({ foo: 'bar' })).toBe(false);
    expect(hasInAppHistory({ idx: '2' })).toBe(false);
  });
});
