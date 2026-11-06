import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { PressableRow } from '@/components/ui/PressableRow';

// PressableRow is hookless, so it can be invoked as a function and its props
// read without a DOM.
type El = ReactElement<{ className: string; disabled?: boolean; type?: string }>;
function render(props: Parameters<typeof PressableRow>[0] = {}): El {
  return PressableRow({ children: 'Row', ...props }) as El;
}
function tokens(el: El): string[] {
  return el.props.className.split(/\s+/).filter(Boolean);
}

describe('PressableRow', () => {
  it('is a full-width, left-aligned, 44px-minimum tappable surface', () => {
    const t = tokens(render());
    expect(t).toContain('min-h-11');
    expect(t).toContain('w-full');
    expect(t).toContain('rounded-lg');
    expect(t).toContain('text-left');
    // Hover keeps the light: the lit-hover overlay, never a flat panel swap.
    expect(t).toContain('lit-hover');
    expect(t).not.toContain('hover:bg-panel-2');
  });

  it('carries a focus-visible ring', () => {
    const t = tokens(render());
    expect(t).toContain('focus-visible:lit-focus');
  });

  it('insetFocus draws the line inside the edge (overflow-hidden cards)', () => {
    const t = tokens(render({ insetFocus: true }));
    expect(t).toContain('focus-visible:lit-focus-inset');
    expect(t).not.toContain('focus-visible:lit-focus');
  });

  it('turns fg-3 and ignores taps when disabled, never a fade', () => {
    const el = render({ disabled: true });
    expect(el.props.disabled).toBe(true);
    expect(tokens(el)).toContain('disabled:text-fg-3');
    expect(tokens(el)).toContain('disabled:pointer-events-none');
    expect(tokens(el).some((c) => /opacity-/.test(c))).toBe(false);
  });

  it('defaults to type=button and appends caller classes last', () => {
    const el = render({ className: 'flex gap-3 px-3' });
    expect(el.props.type).toBe('button');
    expect(el.props.className.endsWith('flex gap-3 px-3')).toBe(true);
  });

  it('inline shrinks to content, flat squares the corners, align centres the text', () => {
    const inline = tokens(render({ inline: true }));
    expect(inline).toContain('w-auto');
    expect(inline).not.toContain('w-full');
    const flat = tokens(render({ flat: true }));
    expect(flat).toContain('rounded-none');
    expect(flat).not.toContain('rounded-lg');
    const centred = tokens(render({ align: 'center' }));
    expect(centred).toContain('text-center');
    expect(centred).not.toContain('text-left');
  });

  it('adds no colour, type or height classes of its own', () => {
    for (const bad of ['text-fg', 'text-fg-2', 'text-base', 'bg-panel', 'border', 'h-11']) {
      expect(tokens(render())).not.toContain(bad);
    }
  });
});

describe('PressableRow press (motion move 5)', () => {
  it('sinks through the shared mv-press class in every shape, dense included', () => {
    for (const props of [{}, { dense: true }, { card: true }, { flat: true }, { inline: true }]) {
      const t = tokens(render(props));
      expect(t).toContain('mv-press');
      expect(t.filter((c) => /^(transition|duration-|active:scale)/.test(c))).toEqual([]);
    }
  });
});
