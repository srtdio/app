import { describe, expect, it } from 'vitest';
import { nextScope } from '@/components/pages/activity/ActivityFilterBar';

describe('nextScope', () => {
  it('selects a tapped scope when a different scope is active', () => {
    expect(nextScope('everything', 'posts')).toBe('posts');
    expect(nextScope('posts', 'briefs')).toBe('briefs');
  });

  it('clears back to the internal default when the active scope is tapped again', () => {
    expect(nextScope('posts', 'posts')).toBe('everything');
  });
});
