import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { Button, ClearButton, type ButtonVariant } from '@/components/ui/Button';
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
      expect(tokens(classOf({ variant }))).toContain('min-w-11');
    }
  });

  it('one size: every button renders 44', () => {
    const t = tokens(classOf({}));
    expect(t).toContain('h-11');
    expect(t).toContain('px-4');
    expect(t).toContain('text-base');
  });

  it('has no size prop: every button is 44 (B1)', () => {
    const src = readFileSync(fileURLToPath(new URL('./Button.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/size\?: 'sm'/);
  });

  it('maps each variant to its level (9 Nov 2026): Main, Button, Tool', () => {
    // MAIN: solid fill, rectangle, no lighting.
    expect(classOf({ variant: 'primary' })).toContain(
      'bg-accent text-accent-fg hover:bg-accent-hover',
    );
    expect(classOf({ variant: 'success' })).toContain('bg-good-solid text-accent-fg');
    expect(classOf({ variant: 'danger' })).toContain('bg-bad-solid text-accent-fg');
    // BUTTON: soft grey fill, no border, fg ink.
    const button = tokens(classOf({ variant: 'secondary' }));
    expect(button).toEqual(expect.arrayContaining(['bg-fg/10', 'hover:bg-fg/15', 'text-fg']));
    expect(button).not.toContain('border');
    expect(button).not.toContain('bg-panel');
    // TOOL: no fill, no border; link is ghost with fg ink (no accent tint).
    for (const variant of ['ghost', 'link'] as const) {
      const t = tokens(classOf({ variant }));
      expect(t).toContain('lit-hover');
      expect(t.some((c) => c.startsWith('bg-'))).toBe(false);
      expect(t).not.toContain('border');
    }
    expect(classOf({ variant: 'ghost' })).toContain('lit-hover text-fg-2 hover:text-fg');
    expect(tokens(classOf({ variant: 'link' }))).toContain('text-fg');
    expect(classOf({ variant: 'link' })).not.toContain('accent');
    expect(classOf({ variant: 'link' })).toContain('!px-2');
  });

  it('no lighting on any button: no lit-btn-* in any variant or shape', () => {
    for (const variant of VARIANTS) {
      for (const shape of ['default', 'round'] as const) {
        expect(classOf({ variant, shape })).not.toMatch(/lit-btn-/);
      }
    }
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

  it('aria-disabled looks exactly like disabled (blocked twins, 9 Nov)', () => {
    for (const variant of VARIANTS) {
      expect(tokens(classOf({ variant }))).toContain('aria-disabled:cursor-default');
    }
    for (const variant of ['primary', 'success', 'danger'] as const) {
      const t = tokens(classOf({ variant }));
      expect(t).toContain('aria-disabled:bg-fg-3');
      expect(t).toContain('aria-disabled:text-accent-fg');
    }
    for (const variant of ['secondary', 'ghost', 'link'] as const) {
      expect(tokens(classOf({ variant }))).toContain('aria-disabled:text-fg-3');
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

  it('there is no pill shape: text buttons are the 8px rectangle', () => {
    const src = readFileSync(fileURLToPath(new URL('./Button.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/export type ButtonShape = 'default' \| 'round';/);
    expect(tokens(classOf())).toContain('rounded-lg');
    expect(tokens(classOf())).toContain('px-4');
  });

  it('ClearButton is a Tool: the word Clear, 44 tall, no outline, no fill, no pill', () => {
    const html = renderToStaticMarkup(<ClearButton aria-label="Clear it" onClick={() => {}} />);
    const tag = /<button[^>]*>/.exec(html)?.[0] ?? '';
    const t = tokens(/class="([^"]*)"/.exec(tag)?.[1] ?? '');
    expect(t).toContain('h-11');
    expect(t).toContain('rounded-lg');
    expect(t).toContain('lit-hover');
    expect(tag).toContain('data-clear-button');
    expect(t).not.toContain('rounded-full');
    expect(t.some((c) => c === 'border' || c.startsWith('border-'))).toBe(false);
    expect(t.some((c) => c.startsWith('bg-'))).toBe(false);
    expect(html).not.toContain('border');
    expect(html).toContain('>Clear</button>');
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

describe('Button busy', () => {
  type El = ReactElement<{
    disabled?: boolean;
    'aria-busy'?: boolean;
    children: unknown[];
    className: string;
  }>;
  const render = (props: Partial<Props>): El => Button({ children: 'Save', ...props }) as El;

  it('busy disables the button and sets aria-busy', () => {
    const el = render({ busy: true });
    expect(el.props.disabled).toBe(true);
    expect(el.props['aria-busy']).toBe(true);
  });

  it('busy keeps the width: the label stays (invisible) and the arc sits over it', () => {
    const html = renderToStaticMarkup(<Button busy>Save</Button>);
    expect(html).toMatch(/data-busy-label=""[^>]*class="invisible[^"]*"[^>]*>Save</);
    expect(html).toContain('data-busy-arc=""');
    expect(html).toContain('mv-spin');
    expect(html).not.toMatch(/opacity-|#[0-9a-fA-F]{3,8}\b|dark:/);
  });

  it('not busy: no spinner, no aria-busy, disabled only when asked', () => {
    const idle = render({});
    expect(idle.props.disabled).toBeUndefined();
    expect(idle.props['aria-busy']).toBeUndefined();
    expect(idle.props.children).toBe('Save');
    expect(render({ disabled: true }).props.disabled).toBe(true);
  });

  it('busy never changes the class string (same look light and dark, no fade)', () => {
    expect(render({ busy: true, variant: 'primary' }).props.className).toBe(
      classOf({ variant: 'primary' }),
    );
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
  type Face = ReactElement<{ className: string }>;
  const faceOf = (el: ReactElement): Face =>
    (el as ReactElement<{ children: Face }>).props.children;

  it('both sizes: a 44 tap box around the 36 chip (px-4), full pill, weight 500, the strong edge', () => {
    for (const size of ['sm', 'tap'] as const) {
      const el = Chip({ label: 'All', size }) as ReactElement<{ className: string }>;
      const box = tokens(el.props.className);
      expect(box).toContain('min-h-11');
      expect(box).toContain('rounded-full');
      expect(box).not.toContain('bg-panel-3');
      const t = tokens(faceOf(el).props.className);
      expect(t).toEqual(expect.arrayContaining(['min-h-9', 'px-4']));
      expect(t).not.toContain('min-h-8');
      expect(t).not.toContain('px-3');
      expect(t).toContain('text-md');
      expect(t).toContain('rounded-full');
      expect(t).toContain('font-medium');
      expect(t).toContain('lit-hover');
      expect(t).toContain('border');
      expect(t).toContain('border-border-strong');
      expect(t).not.toContain('border-border');
      expect(t).toContain('text-fg-2');
      expect(t).not.toContain('bg-panel-3');
      expect(t).not.toContain('lit-well-soft');
      expect(t).not.toContain('border-transparent');
      expect(t).not.toContain('rounded-lg');
    }
  });

  it('selected is the ink line (border-fg, text-fg, no fill); add is dashed, no lit-chip', () => {
    const sel = tokens(
      faceOf(Chip({ label: 'All', selected: true }) as ReactElement).props.className,
    );
    expect(sel).toContain('border-fg');
    expect(sel).toContain('text-fg');
    expect(sel).not.toContain('bg-accent');
    expect(sel).not.toContain('text-accent-fg');
    expect(sel).not.toContain('lit-pill');
    expect(sel).not.toContain('lit-selected');
    expect(sel).not.toContain('border-accent-line');
    expect(sel).not.toContain('bg-accent-soft');
    expect(sel).not.toContain('lit-chip');
    const add = tokens(
      faceOf(Chip({ label: 'Add', variant: 'add' }) as ReactElement).props.className,
    );
    expect(add).not.toContain('border-dashed');
    expect(add).toContain('border-border-strong');
    expect(add).toContain('text-fg');
    expect(add).not.toContain('lit-chip');
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
    const classes = [...VARIANTS.map((variant) => classOf({ variant })), iconClass()];
    // The chip's 44 tap box draws the one focus line on its visible 32 face.
    expect(tokens(chipClass())).toContain('[&:focus-visible>span]:lit-focus');
    expect(tokens(chipClass())).not.toContain('focus:outline-none');
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
    expect(tokens(classOf({ variant: 'primary', shape: 'round' }))).toContain('mv-press');
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
      expect(tokens(cls)).toContain('min-h-11');
      expect(tokens(cls)).toContain('focus-visible:lit-focus');
    }
    expect(tokens(chipClass())).toContain('min-h-11');
    expect(tokens(chipClass())).toContain('[&:focus-visible>span]:lit-focus');
  });
});

describe('Button holds its shape (11 Nov 2026)', () => {
  it('a text label stays on one line and cuts with an ellipsis; never wider than its container; 44 tall', () => {
    for (const variant of VARIANTS) {
      const t = tokens(classOf({ variant, children: 'A very long label that cannot fit' }));
      for (const c of [
        'inline-block',
        'overflow-hidden',
        'text-ellipsis',
        'whitespace-nowrap',
        'max-w-full',
        'h-11',
        'py-3',
      ]) {
        expect(t, `${variant} ${c}`).toContain(c);
      }
    }
    expect(renderToStaticMarkup(<Button>Save</Button>)).toMatch(/>Save<\/button>$/);
  });

  it('beside an icon: one line, never wider than its container, the icon never shrinks', () => {
    const t = tokens(classOf({ children: [<svg key="i" />, 'Send'] }));
    for (const c of ['whitespace-nowrap', 'overflow-hidden', 'max-w-full', '[&>svg]:shrink-0']) {
      expect(t).toContain(c);
    }
    expect(t).not.toContain('inline-block');
  });

  it('an icon-only round button keeps its 44 circle (no text classes)', () => {
    const t = tokens(classOf({ shape: 'round', children: <svg /> }));
    expect(t).toContain('w-11');
    expect(t).not.toContain('text-ellipsis');
  });

  it('switched off: Main keeps the disabled fill, Button and Tool take fg-3, IconButton fg-3', () => {
    for (const variant of ['primary', 'success', 'danger'] as const) {
      expect(tokens(classOf({ variant }))).toEqual(
        expect.arrayContaining(['disabled:bg-fg-3', 'aria-disabled:bg-fg-3']),
      );
    }
    for (const variant of ['secondary', 'ghost', 'link'] as const) {
      expect(tokens(classOf({ variant }))).toEqual(
        expect.arrayContaining(['disabled:text-fg-3', 'aria-disabled:text-fg-3']),
      );
    }
    expect(tokens(classOf({ variant: 'secondary' }))).toContain('aria-disabled:hover:bg-fg/10');
    const icon = renderToStaticMarkup(<IconButton label="Close" disabled />);
    for (const c of [
      'disabled:text-fg-3',
      'aria-disabled:text-fg-3',
      'disabled:pointer-events-none',
    ]) {
      expect(icon).toContain(c);
    }
  });
});
