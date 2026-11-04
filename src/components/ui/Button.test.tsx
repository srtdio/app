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
      'lit-btn-primary bg-accent text-accent-fg hover:bg-accent-hover',
    );
    expect(classOf({ variant: 'secondary' })).toContain(
      'lit-btn-secondary bg-panel text-fg border',
    );
    expect(tokens(classOf({ variant: 'secondary' }))).not.toContain('border-border');
    // Flat: no lit height. The focus line (focus-visible:lit-focus) and the
    // lit-hover overlay are not heights.
    const height = (cls: string) =>
      tokens(cls).filter((c) => c.startsWith('lit-') && c !== 'lit-hover');
    expect(height(classOf({ variant: 'ghost' }))).toEqual([]);
    expect(height(classOf({ variant: 'link' }))).toEqual([]);
    expect(classOf({ variant: 'ghost' })).toContain('lit-hover text-fg-2 hover:text-fg');
    expect(classOf({ variant: 'link' })).toContain('text-accent');
    expect(classOf({ variant: 'link' })).toContain('!px-2');
    expect(classOf({ variant: 'success' })).toContain(
      'lit-btn-success lit-hover bg-good-solid text-accent-fg',
    );
    expect(classOf({ variant: 'danger' })).toContain(
      'lit-btn-danger lit-hover bg-bad-solid text-accent-fg',
    );
  });

  it('hover keeps the light: no flat panel swap and no opacity', () => {
    for (const variant of VARIANTS) {
      expect(classOf({ variant })).not.toMatch(/hover:bg-panel|hover:opacity-/);
    }
  });

  it('disabled never fades: solid fg-3 fill or fg-3 text, no hover, default cursor', () => {
    for (const variant of VARIANTS) {
      const t = tokens(classOf({ variant }));
      expect(t.some((c) => /^disabled:opacity-/.test(c))).toBe(false);
      expect(t).toContain('disabled:pointer-events-none');
      expect(t).toContain('disabled:cursor-default');
    }
    for (const variant of ['primary', 'success', 'danger'] as const) {
      const t = tokens(classOf({ variant }));
      expect(t).toContain('disabled:bg-fg-3');
      expect(t).toContain('disabled:text-accent-fg');
    }
    for (const variant of ['secondary', 'ghost', 'link'] as const) {
      expect(tokens(classOf({ variant }))).toContain('disabled:text-fg-3');
    }
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

  it('is flat (unlit) with a full-strength fg icon', () => {
    const el = IconButton({ label: 'Close', children: null }) as ReactElement<{
      className: string;
    }>;
    const t = tokens(el.props.className);
    expect(t).toContain('text-fg');
    expect(t).not.toContain('text-fg-2');
    // No lit height; lit-hover is the hover/press overlay, not a height.
    expect(t.some((c) => c.startsWith('lit-') && c !== 'lit-hover')).toBe(false);
    expect(t).toContain('lit-hover');
    expect(t).not.toContain('hover:bg-panel-2');
  });

  it('disabled is fg-3 ink with no hover, never a fade', () => {
    const el = IconButton({ label: 'Close', children: null }) as ReactElement<{
      className: string;
    }>;
    const t = tokens(el.props.className);
    expect(t).toContain('disabled:text-fg-3');
    expect(t).toContain('disabled:pointer-events-none');
    expect(t.some((c) => /opacity-/.test(c))).toBe(false);
  });
});

describe('Chip', () => {
  it('both sizes are 44 tall, px-4, 8px radius, weight 500, lit', () => {
    for (const size of ['sm', 'tap'] as const) {
      const el = Chip({ label: 'All', size }) as ReactElement<{ className: string }>;
      const t = tokens(el.props.className);
      expect(t).toContain('min-h-[44px]');
      expect(t).toContain('px-4');
      expect(t).toContain('rounded-lg');
      expect(t).toContain('font-medium');
      expect(t).toContain('lit-chip');
      expect(t).toContain('text-fg');
      expect(t).not.toContain('text-fg-2');
      expect(t).not.toContain('border-border');
      expect(t).toContain('border-border-strong');
      expect(t).not.toContain('h-8');
    }
  });

  it('selected is lit-selected with no soft fill; add is a dashed lit-chip', () => {
    const sel = tokens(
      (Chip({ label: 'All', selected: true }) as ReactElement<{ className: string }>).props
        .className,
    );
    expect(sel).toContain('lit-selected');
    expect(sel).not.toContain('text-accent');
    expect(sel).not.toContain('border-accent-line');
    expect(sel).not.toContain('bg-accent-soft');
    expect(sel).not.toContain('lit-chip');
    const add = tokens(
      (Chip({ label: 'Add', variant: 'add' }) as ReactElement<{ className: string }>).props
        .className,
    );
    expect(add).toContain('border-dashed');
    expect(add).toContain('border-border-strong');
    expect(add).toContain('lit-chip');
  });
});

describe('focus ring lives on the primitives', () => {
  // lit-focus is an offset outline (2px), so it reads on the accent primary fill.
  const RING = ['focus-visible:lit-focus'];
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

  it('Button (every variant), IconButton and Chip carry the lit-focus outline', () => {
    const classes = [...VARIANTS.map((variant) => classOf({ variant })), iconClass(), chipClass()];
    for (const cls of classes) {
      const t = tokens(cls);
      for (const ring of RING) expect(t).toContain(ring);
      expect(t).not.toContain('focus:outline-none');
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

describe('press (motion move 5): the shared mv-press class, never a call-site transition', () => {
  const RETIRED = /^(transition|duration-|active:scale|ease-|motion-(reduce|safe):)/;
  const chipClass = (): string =>
    (Chip({ label: 'All' }) as ReactElement<{ className: string }>).props.className;
  const iconClass = (): string =>
    (IconButton({ label: 'Close', children: null }) as ReactElement<{ className: string }>).props
      .className;

  it('Button (every variant and shape), IconButton and Chip carry mv-press', () => {
    for (const variant of VARIANTS) {
      expect(tokens(classOf({ variant }))).toContain('mv-press');
      expect(tokens(classOf({ variant, shape: 'round' }))).toContain('mv-press');
    }
    expect(tokens(iconClass())).toContain('mv-press');
    expect(tokens(chipClass())).toContain('mv-press');
  });

  it('none keeps its own transition, duration or active scale', () => {
    for (const cls of [classOf(), classOf({ variant: 'primary' }), iconClass(), chipClass()]) {
      expect(tokens(cls).filter((c) => RETIRED.test(c))).toEqual([]);
    }
  });

  it('keeps the 44px target and the one focus ring', () => {
    for (const cls of [classOf(), iconClass()]) {
      expect(tokens(cls)).toContain('min-h-[44px]');
      expect(tokens(cls)).toContain('focus-visible:lit-focus');
    }
    expect(tokens(chipClass())).toContain('focus-visible:lit-focus');
  });
});
