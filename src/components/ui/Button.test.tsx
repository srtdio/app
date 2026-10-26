import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Chip } from '@/components/ui/Chip';

// Button, IconButton and Chip are hookless, so they can be invoked as functions
// and their className read without a DOM.
type Props = Parameters<typeof Button>[0];
function classOf(props: Partial<Props> = {}): string {
  const el = Button({ children: 'Go', ...props }) as ReactElement<{ className: string }>;
  return el.props.className;
}
function tokens(cls: string): string[] {
  return cls.split(/\s+/).filter(Boolean);
}

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'ghost',
  'link',
  'success',
  'danger',
  'default',
];

describe('Button design system', () => {
  it('every variant is 44 tall, 8px radius, 14 / 500', () => {
    for (const variant of VARIANTS) {
      const t = tokens(classOf({ variant }));
      expect(t).toContain('h-11');
      expect(t).toContain('rounded-lg');
      expect(t).toContain('text-base');
      expect(t).toContain('font-medium');
      for (const bad of [
        'h-8',
        'h-9',
        'h-12',
        'rounded-md',
        'rounded-xl',
        'text-sm',
        'font-semibold',
      ]) {
        expect(t).not.toContain(bad);
      }
    }
  });

  it('every variant is at least 44 wide, link included', () => {
    for (const variant of VARIANTS) {
      expect(tokens(classOf({ variant }))).toContain('min-w-[44px]');
    }
  });

  it('sm, md and lg all render 44', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const t = tokens(classOf({ size }));
      expect(t).toContain('h-11');
      expect(t).toContain('px-4');
      expect(t).toContain('text-base');
    }
    expect(classOf({ size: 'sm' })).toBe(classOf({ size: 'lg' }));
  });

  it('does not forward size to the DOM', () => {
    const el = Button({ size: 'sm', children: 'Go' }) as ReactElement<Record<string, unknown>>;
    expect(el.props['size']).toBeUndefined();
  });

  it('maps each variant to its tokens', () => {
    expect(classOf({ variant: 'primary' })).toContain(
      'bg-accent text-accent-fg hover:bg-accent-hover',
    );
    expect(classOf({ variant: 'secondary' })).toContain(
      'bg-panel text-fg border border-border hover:bg-panel-2',
    );
    expect(classOf({ variant: 'ghost' })).toContain('text-fg-2 hover:bg-panel-2 hover:text-fg');
    expect(classOf({ variant: 'link' })).toContain('text-accent');
    expect(classOf({ variant: 'link' })).toContain('!px-2');
    expect(classOf({ variant: 'success' })).toContain(
      'bg-good-solid text-accent-fg hover:opacity-90',
    );
    expect(classOf({ variant: 'danger' })).toContain(
      'bg-bad-solid text-accent-fg hover:opacity-90',
    );
  });

  it("'default' is an alias of secondary and is the default", () => {
    expect(classOf({ variant: 'default' })).toBe(classOf({ variant: 'secondary' }));
    expect(classOf()).toBe(classOf({ variant: 'secondary' }));
  });

  it('shape round is a 44 circle', () => {
    const t = tokens(classOf({ shape: 'round', variant: 'primary' }));
    expect(t).toContain('rounded-full');
    expect(t).toContain('w-11');
    expect(t).toContain('px-0');
    expect(t).not.toContain('rounded-lg');
    expect(t).not.toContain('px-4');
  });

  it('danger and success fill with the solid tokens', () => {
    expect(tokens(classOf({ variant: 'danger' }))).not.toContain('bg-bad');
    expect(tokens(classOf({ variant: 'success' }))).not.toContain('bg-good');
  });

  it('never carries a hex or a dark: literal', () => {
    for (const variant of VARIANTS) {
      expect(classOf({ variant })).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:/);
    }
  });
});

describe('IconButton', () => {
  it('is 44x44 with an 8px radius', () => {
    const el = IconButton({ label: 'Close', children: null }) as ReactElement<{
      className: string;
    }>;
    const t = tokens(el.props.className);
    expect(t).toContain('h-11');
    expect(t).toContain('w-11');
    expect(t).toContain('rounded-lg');
    expect(t).not.toContain('rounded-md');
  });
});

describe('Chip', () => {
  it('both sizes are 44 tall, px-4, 8px radius, weight 400', () => {
    for (const size of ['sm', 'tap'] as const) {
      const el = Chip({ label: 'All', size }) as ReactElement<{ className: string }>;
      const t = tokens(el.props.className);
      expect(t).toContain('min-h-[44px]');
      expect(t).toContain('px-4');
      expect(t).toContain('rounded-lg');
      expect(t).toContain('font-normal');
      expect(t).not.toContain('h-8');
    }
  });
});

describe('focus ring lives on the primitives', () => {
  const RING = [
    'focus:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-accent',
    // Without the offset the ring vanishes on the accent primary fill.
    'focus-visible:ring-offset-2',
    'focus-visible:ring-offset-bg',
  ];
  function iconClass(): string {
    const el = IconButton({ label: 'Close', children: 'x' }) as ReactElement<{
      className: string;
    }>;
    return el.props.className;
  }
  function chipClass(): string {
    const el = Chip({ label: 'All' }) as ReactElement<{ className: string }>;
    return el.props.className;
  }

  it('Button (every variant), IconButton and Chip carry the offset accent ring', () => {
    const classes = [...VARIANTS.map((variant) => classOf({ variant })), iconClass(), chipClass()];
    for (const cls of classes) {
      const t = tokens(cls);
      for (const ring of RING) expect(t).toContain(ring);
    }
  });

  it('success and danger ink is the on-colour token, never text-white', () => {
    for (const variant of ['success', 'danger'] as const) {
      const t = tokens(classOf({ variant }));
      expect(t).toContain('text-accent-fg');
      expect(t).not.toContain('text-white');
    }
  });
});
