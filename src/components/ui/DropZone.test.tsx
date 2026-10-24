import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { DropZone } from '@/components/ui/DropZone';

// DropZone is hookless, so it can be invoked as a function and its props read
// without a DOM.
type El = ReactElement<{ className: string; type?: string; 'aria-label'?: string }>;
function render(props: Parameters<typeof DropZone>[0] = {}): El {
  return DropZone({ children: 'Add images', ...props }) as El;
}
function tokens(el: El): string[] {
  return el.props.className.split(/\s+/).filter(Boolean);
}

describe('DropZone', () => {
  it('renders a type=button carrying its aria-label', () => {
    const el = render({ 'aria-label': 'Add images' });
    expect(el.type).toBe('button');
    expect(el.props.type).toBe('button');
    expect(el.props['aria-label']).toBe('Add images');
  });

  it('is a dashed, strong-bordered panel-2 target with a 12px radius and a centred column', () => {
    const t = tokens(render());
    for (const cls of [
      'border-dashed',
      'border-border-strong',
      'bg-panel-2',
      'rounded-xl',
      'flex-col',
      'items-center',
      'justify-center',
    ]) {
      expect(t).toContain(cls);
    }
  });

  it('carries a focus-visible ring and a disabled fade', () => {
    const t = tokens(render());
    expect(t).toContain('focus-visible:ring-2');
    expect(t).toContain('focus-visible:ring-accent');
    expect(t).toContain('disabled:opacity-50');
  });

  it('takes its minimum height from the minHeight prop, 44px by default', () => {
    expect(tokens(render())).toContain('min-h-[44px]');
    expect(tokens(render({ minHeight: 'tile' }))).toContain('min-h-[120px]');
    expect(tokens(render({ minHeight: 'panel' }))).toContain('min-h-[160px]');
  });
});
