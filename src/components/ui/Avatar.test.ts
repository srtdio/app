import { describe, expect, it } from 'vitest';
import { avatarFillFor } from '@/components/ui/Avatar';

describe('avatarFillFor', () => {
  it('maps a name to one of the six avatar tokens, deterministically', () => {
    const fill = avatarFillFor('Priya Shah');
    expect(fill).toMatch(/^bg-avatar-[1-6]$/);
    expect(avatarFillFor('Priya Shah')).toBe(fill);
  });

  it('covers every token across names and never returns a hex', () => {
    const seen = new Set<string>();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) seen.add(avatarFillFor(name));
    expect(seen.size).toBe(6);
    for (const fill of seen) expect(fill).not.toMatch(/#/);
  });
});
