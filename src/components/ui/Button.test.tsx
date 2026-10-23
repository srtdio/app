import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';

// Button is hookless, so it can be invoked as a function and its className read
// without a DOM.
function classOf(variant: 'danger' | 'success'): string {
  const el = Button({ variant, children: 'Go' }) as ReactElement<{ className: string }>;
  return el.props.className;
}

describe('Button variants', () => {
  it('danger fills with the solid bad token under white ink', () => {
    const cls = classOf('danger');
    expect(cls).toContain('bg-bad-solid');
    expect(cls).toContain('text-white');
    expect(cls.split(' ')).not.toContain('bg-bad');
  });

  it('success fills with the solid good token under white ink', () => {
    const cls = classOf('success');
    expect(cls).toContain('bg-good-solid');
    expect(cls).toContain('text-white');
    expect(cls).toContain('hover:opacity-90');
    expect(cls.split(' ')).not.toContain('bg-good');
  });

  it('never carries a hex or a dark: literal', () => {
    for (const variant of ['danger', 'success'] as const) {
      expect(classOf(variant)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:/);
    }
  });
});
