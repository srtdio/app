// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Backdrop } from '@/components/ui/Backdrop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function markup(position?: 'absolute' | 'fixed'): string {
  return renderToStaticMarkup(
    <Backdrop
      aria-label="Close actions"
      onClick={() => undefined}
      {...(position ? { position } : {})}
    />,
  );
}

describe('Backdrop', () => {
  it('renders one button named by its aria-label', () => {
    const html = markup();
    expect(html.startsWith('<button')).toBe(true);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Close actions"');
  });

  it('is the one scrim dim over inset-0, fixed by default and absolute on request', () => {
    expect(markup()).toMatch(/class="[^"]*\bfixed\b/);
    expect(markup('absolute')).toMatch(/class="[^"]*\babsolute\b/);
    for (const html of [markup(), markup('absolute')]) {
      expect(html).toContain('inset-0');
      expect(html).toContain('bg-scrim');
      expect(html).not.toMatch(/bg-black|hover:/);
    }
  });

  it('fades with a transition that reduced motion turns off', () => {
    const html = markup();
    expect(html).toContain('transition-opacity');
    expect(html).toContain('motion-reduce:transition-none');
  });

  it('calls onClick when tapped', () => {
    const onClick = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Backdrop aria-label="Close" onClick={onClick} />));
    host.querySelector('button')?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
  });
});
