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
    expect(t).toContain('min-h-[44px]');
    expect(t).toContain('w-full');
    expect(t).toContain('rounded-lg');
    expect(t).toContain('text-left');
    expect(t).toContain('hover:bg-panel-2');
  });

  it('carries a focus-visible ring', () => {
    const t = tokens(render());
    expect(t).toContain('focus-visible:ring-2');
    expect(t).toContain('focus-visible:ring-accent');
  });

  it('fades and ignores taps when disabled', () => {
    const el = render({ disabled: true });
    expect(el.props.disabled).toBe(true);
    expect(tokens(el)).toContain('disabled:opacity-50');
    expect(tokens(el)).toContain('disabled:pointer-events-none');
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
